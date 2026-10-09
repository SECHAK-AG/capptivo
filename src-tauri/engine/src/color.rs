//! CSS colour strings from the editor's caption settings.

/// Straight (non-premultiplied) RGBA in 0–1.
pub type Rgba = [f64; 4];

pub fn premultiply(c: Rgba) -> Rgba {
    [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
}

/// `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (comma or space
/// separated, optional `/ alpha`, numbers or percentages) and a few keywords.
/// `None` for anything else, so the caller can fall back to its default.
pub fn parse_css_color(input: &str) -> Option<Rgba> {
    let s = input.trim().to_ascii_lowercase();
    match s.as_str() {
        "transparent" => return Some([0.0, 0.0, 0.0, 0.0]),
        "white" => return Some([1.0, 1.0, 1.0, 1.0]),
        "black" => return Some([0.0, 0.0, 0.0, 1.0]),
        _ => {}
    }
    if let Some(hex) = s.strip_prefix('#') {
        return parse_hex(hex);
    }
    let body = s
        .strip_prefix("rgba(")
        .or_else(|| s.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let parts: Vec<&str> = body
        .split(|c: char| c == ',' || c == '/' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() != 3 && parts.len() != 4 {
        return None;
    }
    let channel = |p: &str| -> Option<f64> {
        let v = match p.strip_suffix('%') {
            Some(pct) => pct.parse::<f64>().ok()? / 100.0,
            None => p.parse::<f64>().ok()? / 255.0,
        };
        Some(v.clamp(0.0, 1.0))
    };
    let alpha = match parts.get(3) {
        None => 1.0,
        Some(p) => match p.strip_suffix('%') {
            Some(pct) => pct.parse::<f64>().ok()? / 100.0,
            None => p.parse::<f64>().ok()?,
        }
        .clamp(0.0, 1.0),
    };
    Some([
        channel(parts[0])?,
        channel(parts[1])?,
        channel(parts[2])?,
        alpha,
    ])
}

fn parse_hex(hex: &str) -> Option<Rgba> {
    let nibble = |c: u8| (c as char).to_digit(16).map(|d| d as f64);
    let bytes = hex.as_bytes();
    let digits: Option<Vec<f64>> = match bytes.len() {
        3 | 4 => bytes
            .iter()
            .map(|&c| nibble(c).map(|d| (d * 17.0) / 255.0))
            .collect(),
        6 | 8 => bytes
            .chunks(2)
            .map(|pair| Some((nibble(pair[0])? * 16.0 + nibble(pair[1])?) / 255.0))
            .collect(),
        _ => None,
    };
    let d = digits?;
    Some([d[0], d[1], d[2], d.get(3).copied().unwrap_or(1.0)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_editor_defaults() {
        assert_eq!(parse_css_color("#ffffff"), Some([1.0, 1.0, 1.0, 1.0]));
        let c = parse_css_color("rgba(8, 8, 10, 0.82)").unwrap();
        assert!((c[0] - 8.0 / 255.0).abs() < 1e-12 && (c[3] - 0.82).abs() < 1e-12);
        let c = parse_css_color("rgba(255, 255, 255, 0.22)").unwrap();
        assert!((c[3] - 0.22).abs() < 1e-12);
    }

    #[test]
    fn parses_short_hex_and_space_syntax() {
        assert_eq!(parse_css_color("#0f0"), Some([0.0, 1.0, 0.0, 1.0]));
        let c = parse_css_color("rgb(255 0 0 / 50%)").unwrap();
        assert_eq!(c, [1.0, 0.0, 0.0, 0.5]);
        assert_eq!(parse_css_color("hsl(0, 0%, 0%)"), None);
    }
}
