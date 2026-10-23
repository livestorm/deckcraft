//! Which font files to fetch for a family a document uses but the machine doesn't have: the
//! family itself, its open stand-ins, then a generic face of the same kind (serif, sans or
//! monospace). The browser player asks a font server for these names, one family at a time.

use crate::script::ScriptTag;
use crate::substitutes;

/// The kind of face a missing family is drawn as when nothing closer is found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Sans,
    Serif,
    Mono,
}

impl Category {
    /// The open family drawn for a missing family of this kind (Arial's, Times New Roman's and
    /// Courier New's widths, so lines break close to where the presenter's did).
    pub fn generic_family(self) -> &'static str {
        match self {
            Category::Sans => "Arimo",
            Category::Serif => "Tinos",
            Category::Mono => "Cousine",
        }
    }
}

/// The kind of face `family` is: from `pitchFamily` (its family bits, then fixed pitch), then
/// `panose` (serif style, proportion), then words in the name; sans when nothing says.
pub fn category_of(family: &str, pitch_family: Option<u8>, panose: Option<&str>) -> Category {
    if let Some(p) = pitch_family {
        match p & 0xF0 {
            0x10 => return Category::Serif,
            0x20 => return Category::Sans,
            0x30 => return Category::Mono,
            _ if p & 0x03 == 1 => return Category::Mono,
            _ => {}
        }
    }
    if let Some(bytes) = panose.and_then(panose_bytes)
        && bytes[0] == 2
    {
        if bytes[3] == 9 {
            return Category::Mono;
        }
        match bytes[1] {
            2..=10 => return Category::Serif,
            11..=15 => return Category::Sans,
            _ => {}
        }
    }
    let name = family.to_ascii_lowercase();
    let words = |list: &[&str]| list.iter().any(|w| name.contains(w));
    if words(&["mono", "code", "courier", "consol", "typewriter"]) {
        Category::Mono
    } else if name.contains("serif") && !name.contains("sans") || words(&["times", "garamond", "georgia", "roman", "slab"]) {
        Category::Serif
    } else {
        Category::Sans
    }
}

/// The 10 bytes of a 20-hex-digit `panose`.
fn panose_bytes(panose: &str) -> Option<[u8; 10]> {
    let mut out = [0u8; 10];
    let digits = panose.trim();
    if digits.len() != 20 {
        return None;
    }
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(digits.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Weight words documents put in family names ("Montserrat Light"), longest first.
const WEIGHT_WORDS: &[(&str, u16)] = &[
    ("extralight", 200),
    ("ultralight", 200),
    ("extrabold", 800),
    ("ultrabold", 800),
    ("semibold", 600),
    ("demibold", 600),
    ("thin", 100),
    ("light", 300),
    ("medium", 500),
    ("black", 900),
    ("heavy", 900),
];

/// A family named with its weight ("Montserrat Light", "Poppins SemiBold"): the base family and
/// the weight. Other names come back whole, with no weight.
pub fn split_weight(family: &str) -> (&str, Option<u16>) {
    let family = family.trim();
    let Some((base, last)) = family.rsplit_once(' ') else { return (family, None) };
    let word = last.to_ascii_lowercase().replace('-', "");
    match WEIGHT_WORDS.iter().find(|(w, _)| *w == word) {
        Some((_, weight)) if !base.trim().is_empty() => (base.trim(), Some(*weight)),
        _ => (family, None),
    }
}

/// The families to try for `family`, in order: itself, its base family when the name carries a
/// weight, their open stand-ins, then the generic family for `category`. No duplicates.
pub fn candidates(family: &str, category: Category) -> Vec<String> {
    let (base, _) = split_weight(family);
    let mut out: Vec<String> = Vec::new();
    let names = [family, base].into_iter().chain(substitutes(family).iter().copied()).chain(substitutes(base).iter().copied());
    for name in names.chain([category.generic_family()]) {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(name)) {
            out.push(name.to_string());
        }
    }
    out
}

/// The open family that draws text in `script` when the document's fonts don't, for scripts
/// Latin fonts don't cover.
pub fn script_family(script: ScriptTag) -> Option<&'static str> {
    Some(match &script {
        b"Jpan" | b"Hira" | b"Kana" => "BIZ UDPGothic",
        b"Hang" | b"Kore" => "Noto Sans KR",
        b"Hans" | b"Hani" => "Noto Sans SC",
        b"Hant" => "Noto Sans TC",
        b"Arab" => "Noto Naskh Arabic",
        b"Hebr" => "Noto Sans Hebrew",
        b"Thai" => "Noto Sans Thai",
        b"Deva" => "Noto Sans Devanagari",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pitch_family_decides_first() {
        assert_eq!(category_of("Foo", Some(0x12), None), Category::Serif);
        assert_eq!(category_of("Foo Serif", Some(0x22), None), Category::Sans);
        assert_eq!(category_of("Foo", Some(0x31), None), Category::Mono);
        assert_eq!(category_of("Foo", Some(0x01), None), Category::Mono);
    }

    #[test]
    fn panose_decides_next() {
        assert_eq!(category_of("Foo", None, Some("02020603050405020304")), Category::Serif);
        assert_eq!(category_of("Foo", None, Some("020B0604020202020204")), Category::Sans);
        assert_eq!(category_of("Foo", None, Some("020B0609020202020204")), Category::Mono);
        assert_eq!(category_of("Foo", Some(0x02), Some("02020603050405020304")), Category::Serif);
    }

    #[test]
    fn the_name_decides_last_and_sans_is_the_default() {
        assert_eq!(category_of("Fira Code", None, None), Category::Mono);
        assert_eq!(category_of("Noto Serif Display", None, None), Category::Serif);
        assert_eq!(category_of("PT Sans Narrow", None, None), Category::Sans);
        assert_eq!(category_of("Brand Grotesk", None, Some("not panose")), Category::Sans);
    }

    #[test]
    fn weight_words_split_off_the_family() {
        assert_eq!(split_weight("Montserrat Light"), ("Montserrat", Some(300)));
        assert_eq!(split_weight("Poppins SemiBold"), ("Poppins", Some(600)));
        assert_eq!(split_weight("Open Sans ExtraBold"), ("Open Sans", Some(800)));
        assert_eq!(split_weight("Segoe UI Semi-bold"), ("Segoe UI", Some(600)));
        assert_eq!(split_weight("Lato"), ("Lato", None));
        assert_eq!(split_weight("Light"), ("Light", None));
    }

    #[test]
    fn candidates_go_from_the_family_to_its_stand_ins_to_the_generic_face() {
        assert_eq!(candidates("Calibri", Category::Sans)[..2], ["Calibri", "Carlito"]);
        assert_eq!(candidates("Calibri", Category::Sans).last().map(String::as_str), Some("Arimo"));
        // The metric-compatible twin comes straight after Liberation's, before any look-alike.
        assert_eq!(candidates("Arial", Category::Sans)[..3], ["Arial", "Liberation Sans", "Arimo"]);
        assert_eq!(candidates("Helvetica", Category::Sans)[..3], ["Helvetica", "Liberation Sans", "Arimo"]);
        assert_eq!(candidates("Times New Roman", Category::Serif)[..3], ["Times New Roman", "Liberation Serif", "Tinos"]);
        assert_eq!(candidates("Courier New", Category::Mono)[..3], ["Courier New", "Liberation Mono", "Cousine"]);
        assert_eq!(candidates("Montserrat Light", Category::Sans), ["Montserrat Light", "Montserrat", "Inter", "Arimo"]);
        assert_eq!(candidates("Old Foundry Serif", Category::Serif), ["Old Foundry Serif", "Tinos"]);
    }

    #[test]
    fn scripts_latin_fonts_miss_have_a_family() {
        assert_eq!(script_family(*b"Jpan"), Some("BIZ UDPGothic"));
        assert_eq!(script_family(*b"Arab"), Some("Noto Naskh Arabic"));
        assert_eq!(script_family(*b"Latn"), None);
    }
}
