//! Turns browser keyboard events into the bytes a terminal application expects.

/// A `keydown` as the renderer observed it. `key` carries the DOM
/// `KeyboardEvent.key` value verbatim — no intermediate naming scheme.
#[derive(Debug, Clone)]
pub struct KeyInput {
    pub key: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    /// Whether the terminal has DECCKM (application cursor keys) enabled.
    /// Neovim turns it on, which changes what the arrow keys must emit.
    pub application_cursor: bool,
}

/// Encode a key press as PTY bytes.
///
/// Returns `None` when the key produces no terminal input — a bare modifier, an
/// unmapped key, or anything held with Meta (reserved for the host
/// application's own shortcuts). `None` is deliberately distinct from an empty
/// byte string, which would be indistinguishable from a key that legitimately
/// sends nothing.
pub fn encode_key(input: &KeyInput) -> Option<Vec<u8>> {
    // Meta belongs to Cadencr's shortcut system, not the terminal.
    if input.meta {
        return None;
    }

    let mut bytes = encode_unprefixed(input)?;

    // "Meta sends escape": Alt prefixes whatever the key would otherwise emit.
    if input.alt {
        let mut prefixed = Vec::with_capacity(bytes.len() + 1);
        prefixed.push(0x1B);
        prefixed.append(&mut bytes);
        return Some(prefixed);
    }

    Some(bytes)
}

fn encode_unprefixed(input: &KeyInput) -> Option<Vec<u8>> {
    if let Some(bytes) = encode_named_key(&input.key, input.application_cursor) {
        return Some(bytes);
    }

    let mut chars = input.key.chars();
    let ch = chars.next()?;
    // A multi-character `key` that isn't a known name is a modifier or a
    // composition state ("Shift", "Dead", …) — nothing to send.
    if chars.next().is_some() {
        return None;
    }

    if input.ctrl {
        return encode_control(ch).map(|byte| vec![byte]);
    }

    let mut buffer = [0_u8; 4];
    Some(ch.encode_utf8(&mut buffer).as_bytes().to_vec())
}

/// Ctrl+<key> in the C0 control range.
fn encode_control(ch: char) -> Option<u8> {
    match ch {
        'a'..='z' => Some(ch as u8 - b'a' + 1),
        'A'..='Z' => Some(ch as u8 - b'A' + 1),
        // The four non-letter control codes that see real use — Ctrl+[ in
        // particular is how many users leave insert mode.
        '[' => Some(0x1B),
        '\\' => Some(0x1C),
        ']' => Some(0x1D),
        '_' => Some(0x1F),
        ' ' => Some(0x00),
        _ => None,
    }
}

/// Keys the DOM names rather than describing by character.
fn encode_named_key(key: &str, application_cursor: bool) -> Option<Vec<u8>> {
    // In application cursor mode (DECCKM) the cursor keys switch from CSI to
    // SS3. Neovim enables it, so this is the common case, not an edge case.
    let cursor = |final_byte: u8| -> Vec<u8> {
        if application_cursor {
            vec![0x1B, b'O', final_byte]
        } else {
            vec![0x1B, b'[', final_byte]
        }
    };

    let bytes = match key {
        "Enter" => vec![0x0D],
        "Tab" => vec![0x09],
        "Escape" => vec![0x1B],
        // DEL, not BS: 0x08 would be read as Ctrl+H.
        "Backspace" => vec![0x7F],

        "ArrowUp" => cursor(b'A'),
        "ArrowDown" => cursor(b'B'),
        "ArrowRight" => cursor(b'C'),
        "ArrowLeft" => cursor(b'D'),
        "Home" => cursor(b'H'),
        "End" => cursor(b'F'),

        "PageUp" => b"\x1b[5~".to_vec(),
        "PageDown" => b"\x1b[6~".to_vec(),
        "Insert" => b"\x1b[2~".to_vec(),
        "Delete" => b"\x1b[3~".to_vec(),

        "F1" => b"\x1bOP".to_vec(),
        "F2" => b"\x1bOQ".to_vec(),
        "F3" => b"\x1bOR".to_vec(),
        "F4" => b"\x1bOS".to_vec(),
        "F5" => b"\x1b[15~".to_vec(),
        "F6" => b"\x1b[17~".to_vec(),
        "F7" => b"\x1b[18~".to_vec(),
        "F8" => b"\x1b[19~".to_vec(),
        "F9" => b"\x1b[20~".to_vec(),
        "F10" => b"\x1b[21~".to_vec(),
        "F11" => b"\x1b[23~".to_vec(),
        "F12" => b"\x1b[24~".to_vec(),

        _ => return None,
    };

    Some(bytes)
}

/// Which mouse reports the running application asked for. Read from the
/// terminal's mode flags — never assumed, because reporting into a program
/// that never enabled the mouse injects junk bytes into its input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseReporting {
    /// The application wants nothing.
    None,
    /// Press and release only.
    Click,
    /// Press, release, and motion while a button is held.
    Drag,
    /// Press, release, and all motion.
    Motion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    None,
    Left,
    Middle,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseEventKind {
    Press,
    Release,
    Move,
    ScrollUp,
    ScrollDown,
}

/// A mouse event, with cell coordinates already resolved from pixels.
#[derive(Debug, Clone, Copy)]
pub struct MouseInput {
    pub kind: MouseEventKind,
    pub button: MouseButton,
    /// 0-indexed cell coordinates; the SGR encoding is 1-indexed and converts.
    pub line: usize,
    pub column: usize,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// Whether the application enabled SGR (1006) mouse encoding.
    pub sgr_enabled: bool,
    pub reporting: MouseReporting,
    /// Whether alternate scroll is enabled.
    pub alternate_scroll: bool,
    /// Whether the alternate screen is active.
    pub alt_screen: bool,
    /// Whether DECCKM (application cursor keys) is enabled, which changes the
    /// arrow-key prefix the alternate-scroll translation must emit.
    pub application_cursor: bool,
}

/// Encode a mouse event as PTY bytes.
///
/// Returns `None` whenever the event must not be reported: the application
/// asked for no mouse, it asked for a narrower reporting mode than this event
/// needs, or it never enabled SGR encoding. Only SGR (1006) is supported — the
/// historical X10 encoding caps coordinates at column 223, which any wide
/// editor pane exceeds.
pub fn encode_mouse(input: &MouseInput) -> Option<Vec<u8>> {
    // The wheel drives the alternate screen's pager directly when alternate
    // scroll is on and this encoder cannot emit the requested mouse protocol.
    if (input.reporting == MouseReporting::None || !input.sgr_enabled)
        && input.alternate_scroll
        && input.alt_screen
    {
        // Under DECCKM the arrows are SS3-prefixed (`ESC O A`), not CSI. Neovim
        // and every full-screen pager enable it, so emitting CSI here would send
        // bytes the running program does not read as arrow keys.
        let arrow = |final_byte: u8| -> Vec<u8> {
            if input.application_cursor {
                vec![0x1B, b'O', final_byte]
            } else {
                vec![0x1B, b'[', final_byte]
            }
        };
        match input.kind {
            MouseEventKind::ScrollUp => return Some(arrow(b'A')),
            MouseEventKind::ScrollDown => return Some(arrow(b'B')),
            _ => {}
        }
    }

    if input.reporting == MouseReporting::None || !input.sgr_enabled {
        return None;
    }

    let button = mouse_button_code(input)?;
    let final_byte = if input.kind == MouseEventKind::Release {
        b'm'
    } else {
        b'M'
    };

    // SGR coordinates are 1-indexed, and the column comes before the line.
    let sequence = format!(
        "\x1b[<{};{};{}{}",
        button,
        input.column + 1,
        input.line + 1,
        final_byte as char
    );
    Some(sequence.into_bytes())
}

/// The button field, including the motion bit and the modifier bits.
/// `None` when this event kind is not reportable under the active mode.
fn mouse_button_code(input: &MouseInput) -> Option<u32> {
    let base = match input.kind {
        MouseEventKind::ScrollUp => 64,
        MouseEventKind::ScrollDown => 65,
        MouseEventKind::Press | MouseEventKind::Release => match input.button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            MouseButton::Right => 2,
            // A press with no button is not a thing worth reporting.
            MouseButton::None => return None,
        },
        MouseEventKind::Move => {
            let allowed = match (input.button, input.reporting) {
                // Motion with a button held needs drag reporting or better.
                (MouseButton::None, MouseReporting::Motion) => true,
                (MouseButton::None, _) => false,
                (_, MouseReporting::Drag | MouseReporting::Motion) => true,
                (_, _) => false,
            };
            if !allowed {
                return None;
            }
            // Bit 32 marks motion, on top of whichever button is held.
            let held = match input.button {
                MouseButton::Left => 0,
                MouseButton::Middle => 1,
                MouseButton::Right => 2,
                // 3 is the "no button" code the protocol uses for bare motion.
                MouseButton::None => 3,
            };
            32 + held
        }
    };

    Some(base + modifier_bits(input))
}

/// Shift = 4, Alt = 8, Ctrl = 16, per the mouse protocol.
fn modifier_bits(input: &MouseInput) -> u32 {
    let mut bits = 0;
    if input.shift {
        bits += 4;
    }
    if input.alt {
        bits += 8;
    }
    if input.ctrl {
        bits += 16;
    }
    bits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(key: &str) -> Option<Vec<u8>> {
        encode_key(&KeyInput {
            key: key.to_string(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
            application_cursor: false,
        })
    }

    fn with_ctrl(key: &str) -> Option<Vec<u8>> {
        encode_key(&KeyInput {
            key: key.to_string(),
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
            application_cursor: false,
        })
    }

    fn mouse(kind: MouseEventKind, button: MouseButton, line: usize, column: usize) -> MouseInput {
        MouseInput {
            kind,
            button,
            line,
            column,
            ctrl: false,
            alt: false,
            shift: false,
            sgr_enabled: true,
            reporting: MouseReporting::Click,
            alternate_scroll: false,
            alt_screen: false,
            application_cursor: false,
        }
    }

    #[test]
    fn printable_characters_encode_as_utf8() {
        assert_eq!(plain("a"), Some(b"a".to_vec()));
        assert_eq!(plain("Z"), Some(b"Z".to_vec()));
        assert_eq!(plain("é"), Some("é".as_bytes().to_vec()));
        assert_eq!(plain("🦀"), Some("🦀".as_bytes().to_vec()));
    }

    #[test]
    fn named_control_keys_encode_to_their_bytes() {
        assert_eq!(plain("Enter"), Some(vec![0x0D]));
        assert_eq!(plain("Tab"), Some(vec![0x09]));
        assert_eq!(plain("Escape"), Some(vec![0x1B]));
    }

    #[test]
    fn backspace_sends_del_not_backspace() {
        // 0x08 would be read as Ctrl+H; modern Unix terminals send DEL.
        assert_eq!(plain("Backspace"), Some(vec![0x7F]));
    }

    #[test]
    fn ctrl_letters_map_onto_the_control_range() {
        assert_eq!(with_ctrl("a"), Some(vec![0x01]));
        assert_eq!(with_ctrl("A"), Some(vec![0x01]));
        assert_eq!(with_ctrl("c"), Some(vec![0x03]));
        assert_eq!(with_ctrl("z"), Some(vec![0x1A]));
    }

    #[test]
    fn ctrl_bracket_is_escape() {
        // Ctrl+[ is how a great many Neovim users leave insert mode.
        assert_eq!(with_ctrl("["), Some(vec![0x1B]));
        assert_eq!(with_ctrl("\\"), Some(vec![0x1C]));
        assert_eq!(with_ctrl("]"), Some(vec![0x1D]));
        assert_eq!(with_ctrl("_"), Some(vec![0x1F]));
    }

    #[test]
    fn alt_prefixes_an_escape() {
        let encoded = encode_key(&KeyInput {
            key: "b".to_string(),
            ctrl: false,
            alt: true,
            shift: false,
            meta: false,
            application_cursor: false,
        });
        assert_eq!(encoded, Some(vec![0x1B, b'b']));
    }

    #[test]
    fn alt_combines_with_ctrl() {
        let encoded = encode_key(&KeyInput {
            key: "c".to_string(),
            ctrl: true,
            alt: true,
            shift: false,
            meta: false,
            application_cursor: false,
        });
        assert_eq!(encoded, Some(vec![0x1B, 0x03]));
    }

    #[test]
    fn arrows_use_csi_in_normal_cursor_mode() {
        assert_eq!(plain("ArrowUp"), Some(b"\x1b[A".to_vec()));
        assert_eq!(plain("ArrowDown"), Some(b"\x1b[B".to_vec()));
        assert_eq!(plain("ArrowRight"), Some(b"\x1b[C".to_vec()));
        assert_eq!(plain("ArrowLeft"), Some(b"\x1b[D".to_vec()));
    }

    #[test]
    fn arrows_use_ss3_in_application_cursor_mode() {
        // Neovim turns DECCKM on; getting this wrong breaks every arrow key.
        let up = encode_key(&KeyInput {
            key: "ArrowUp".to_string(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
            application_cursor: true,
        });
        assert_eq!(up, Some(b"\x1bOA".to_vec()));
    }

    #[test]
    fn navigation_and_editing_keys_encode_to_csi_sequences() {
        assert_eq!(plain("Home"), Some(b"\x1b[H".to_vec()));
        assert_eq!(plain("End"), Some(b"\x1b[F".to_vec()));
        assert_eq!(plain("PageUp"), Some(b"\x1b[5~".to_vec()));
        assert_eq!(plain("PageDown"), Some(b"\x1b[6~".to_vec()));
        assert_eq!(plain("Insert"), Some(b"\x1b[2~".to_vec()));
        assert_eq!(plain("Delete"), Some(b"\x1b[3~".to_vec()));
    }

    #[test]
    fn function_keys_encode_to_their_conventional_sequences() {
        assert_eq!(plain("F1"), Some(b"\x1bOP".to_vec()));
        assert_eq!(plain("F4"), Some(b"\x1bOS".to_vec()));
        assert_eq!(plain("F5"), Some(b"\x1b[15~".to_vec()));
        assert_eq!(plain("F12"), Some(b"\x1b[24~".to_vec()));
    }

    #[test]
    fn meta_modified_keys_are_left_to_the_host_application() {
        // Cmd+S must reach Cadencr's shortcut system, not the terminal.
        let encoded = encode_key(&KeyInput {
            key: "s".to_string(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: true,
            application_cursor: false,
        });
        assert_eq!(encoded, None);
    }

    #[test]
    fn unknown_keys_return_none_rather_than_empty_bytes() {
        // None is distinguishable from "a key that legitimately sends nothing";
        // an empty Vec would not be.
        assert_eq!(plain("Shift"), None);
        assert_eq!(plain("Control"), None);
        assert_eq!(plain("Dead"), None);
        assert_eq!(plain("F13"), None);
    }

    #[test]
    fn a_left_click_encodes_as_sgr_press() {
        let encoded = encode_mouse(&mouse(MouseEventKind::Press, MouseButton::Left, 0, 0));
        assert_eq!(encoded, Some(b"\x1b[<0;1;1M".to_vec()));
    }

    #[test]
    fn coordinates_are_converted_from_zero_to_one_indexed() {
        let encoded = encode_mouse(&mouse(MouseEventKind::Press, MouseButton::Left, 9, 4));
        assert_eq!(encoded, Some(b"\x1b[<0;5;10M".to_vec()));
    }

    #[test]
    fn buttons_map_to_their_protocol_numbers() {
        let middle = encode_mouse(&mouse(MouseEventKind::Press, MouseButton::Middle, 0, 0));
        let right = encode_mouse(&mouse(MouseEventKind::Press, MouseButton::Right, 0, 0));
        assert_eq!(middle, Some(b"\x1b[<1;1;1M".to_vec()));
        assert_eq!(right, Some(b"\x1b[<2;1;1M".to_vec()));
    }

    #[test]
    fn a_release_ends_with_lowercase_m() {
        let encoded = encode_mouse(&mouse(MouseEventKind::Release, MouseButton::Left, 0, 0));
        assert_eq!(encoded, Some(b"\x1b[<0;1;1m".to_vec()));
    }

    #[test]
    fn modifiers_are_folded_into_the_button_field() {
        let mut input = mouse(MouseEventKind::Press, MouseButton::Left, 0, 0);
        input.shift = true;
        assert_eq!(encode_mouse(&input), Some(b"\x1b[<4;1;1M".to_vec()));

        let mut input = mouse(MouseEventKind::Press, MouseButton::Left, 0, 0);
        input.alt = true;
        assert_eq!(encode_mouse(&input), Some(b"\x1b[<8;1;1M".to_vec()));

        let mut input = mouse(MouseEventKind::Press, MouseButton::Left, 0, 0);
        input.ctrl = true;
        assert_eq!(encode_mouse(&input), Some(b"\x1b[<16;1;1M".to_vec()));
    }

    #[test]
    fn the_wheel_encodes_as_buttons_64_and_65() {
        let up = encode_mouse(&mouse(MouseEventKind::ScrollUp, MouseButton::None, 0, 0));
        let down = encode_mouse(&mouse(MouseEventKind::ScrollDown, MouseButton::None, 0, 0));
        assert_eq!(up, Some(b"\x1b[<64;1;1M".to_vec()));
        assert_eq!(down, Some(b"\x1b[<65;1;1M".to_vec()));
    }

    #[test]
    fn the_wheel_sends_arrows_under_alternate_scroll() {
        let mut input = mouse(MouseEventKind::ScrollUp, MouseButton::None, 0, 0);
        input.reporting = MouseReporting::None;
        input.alternate_scroll = true;
        input.alt_screen = true;
        assert_eq!(encode_mouse(&input), Some(b"\x1b[A".to_vec()));

        let mut input = mouse(MouseEventKind::ScrollDown, MouseButton::None, 0, 0);
        input.reporting = MouseReporting::None;
        input.alternate_scroll = true;
        input.alt_screen = true;
        assert_eq!(encode_mouse(&input), Some(b"\x1b[B".to_vec()));
    }

    #[test]
    fn alternate_scroll_arrows_follow_application_cursor_mode() {
        // Neovim and pagers enable DECCKM, which moves the arrows from CSI to
        // SS3. Emitting CSI there sends bytes the program does not read as
        // arrow keys, so the wheel would silently do nothing.
        let mut input = mouse(MouseEventKind::ScrollUp, MouseButton::None, 0, 0);
        input.reporting = MouseReporting::None;
        input.alternate_scroll = true;
        input.alt_screen = true;
        input.application_cursor = true;
        assert_eq!(encode_mouse(&input), Some(b"\x1bOA".to_vec()));

        let mut input = mouse(MouseEventKind::ScrollDown, MouseButton::None, 0, 0);
        input.reporting = MouseReporting::None;
        input.alternate_scroll = true;
        input.alt_screen = true;
        input.application_cursor = true;
        assert_eq!(encode_mouse(&input), Some(b"\x1bOB".to_vec()));
    }

    #[test]
    fn unsupported_mouse_protocol_keeps_alternate_scroll_arrows() {
        for application_cursor in [false, true] {
            for (kind, suffix) in [
                (MouseEventKind::ScrollUp, b'A'),
                (MouseEventKind::ScrollDown, b'B'),
            ] {
                let mut input = mouse(kind, MouseButton::None, 0, 0);
                input.reporting = MouseReporting::Click;
                input.sgr_enabled = false;
                input.alternate_scroll = true;
                input.alt_screen = true;
                input.application_cursor = application_cursor;
                assert_eq!(
                    encode_mouse(&input),
                    Some(vec![
                        0x1b,
                        if application_cursor { b'O' } else { b'[' },
                        suffix
                    ])
                );
                input.alternate_scroll = false;
                assert_eq!(encode_mouse(&input), None);
            }
        }
    }

    #[test]
    fn mouse_reporting_takes_priority_over_alternate_scroll() {
        let mut input = mouse(MouseEventKind::ScrollDown, MouseButton::None, 2, 3);
        input.alternate_scroll = true;
        input.alt_screen = true;
        input.application_cursor = true;
        assert_eq!(encode_mouse(&input), Some(b"\x1b[<65;4;3M".to_vec()));
    }

    #[test]
    fn nothing_is_reported_when_the_application_asked_for_no_mouse() {
        let mut input = mouse(MouseEventKind::Press, MouseButton::Left, 0, 0);
        input.reporting = MouseReporting::None;
        assert_eq!(
            encode_mouse(&input),
            None,
            "reporting into a program that never enabled the mouse would inject junk"
        );
    }

    #[test]
    fn nothing_is_reported_without_sgr_support() {
        let mut input = mouse(MouseEventKind::Press, MouseButton::Left, 0, 0);
        input.sgr_enabled = false;
        assert_eq!(encode_mouse(&input), None);
    }

    #[test]
    fn motion_requires_the_matching_reporting_mode() {
        let mut drag = mouse(MouseEventKind::Move, MouseButton::Left, 2, 3);
        drag.reporting = MouseReporting::Click;
        assert_eq!(
            encode_mouse(&drag),
            None,
            "click-only mode must not report motion"
        );

        let mut drag = mouse(MouseEventKind::Move, MouseButton::Left, 2, 3);
        drag.reporting = MouseReporting::Drag;
        assert_eq!(encode_mouse(&drag), Some(b"\x1b[<32;4;3M".to_vec()));

        let mut hover = mouse(MouseEventKind::Move, MouseButton::None, 2, 3);
        hover.reporting = MouseReporting::Drag;
        assert_eq!(
            encode_mouse(&hover),
            None,
            "drag mode must not report bare hover"
        );

        let mut hover = mouse(MouseEventKind::Move, MouseButton::None, 2, 3);
        hover.reporting = MouseReporting::Motion;
        assert_eq!(hover_is_reported(&hover), true);
    }

    fn hover_is_reported(input: &MouseInput) -> bool {
        encode_mouse(input).is_some()
    }
}
