//! The fonts a presentation's slides draw text in: each Latin family with the styles it is used
//! in, what the file says about it (`FontHint`) and the text it draws, so a player can fetch just
//! those fonts and a host can list the missing ones.

use std::collections::BTreeSet;

use crate::resolve::{self, Ctx};
use crate::text::{Bullet, FontHint, TextBody};
use crate::{Presentation, Shape, ShapeKind};

/// At most this many distinct characters are kept per family (enough to tell its scripts).
const MAX_CHARS: usize = 4096;

/// One family the slides' text runs or bullets are drawn in.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsedFont {
    /// As the document names it, theme references resolved.
    pub family: String,
    /// `panose` / `pitchFamily` for this family, when the file gave them.
    pub hint: Option<FontHint>,
    /// (bold, italic) pairs the family is used in.
    pub styles: BTreeSet<(bool, bool)>,
    /// The distinct characters drawn in it, in first-seen order.
    pub chars: String,
}

/// The families the slides' text runs and bullets are drawn in, in first-seen order, without
/// duplicates (case-insensitive).
pub fn used_fonts(p: &Presentation) -> Vec<UsedFont> {
    let mut out: Vec<UsedFont> = Vec::new();
    for slide in &p.slides {
        let Some(ctx) = Ctx::for_slide(p, slide) else { continue };
        crate::walk(&slide.shapes, &mut |s, _| {
            if let Some(body) = &s.text {
                body_fonts(&ctx, s, body, &mut out);
            }
            if let ShapeKind::Table(t) = &s.kind {
                for cell in t.rows.iter().flat_map(|r| &r.cells) {
                    body_fonts(&ctx, s, &cell.text, &mut out);
                }
            }
        });
    }
    out
}

fn entry<'a>(out: &'a mut Vec<UsedFont>, family: &str) -> Option<&'a mut UsedFont> {
    let family = family.trim();
    if family.is_empty() {
        return None;
    }
    let i = match out.iter().position(|u| u.family.eq_ignore_ascii_case(family)) {
        Some(i) => i,
        None => {
            out.push(UsedFont { family: family.to_string(), ..Default::default() });
            out.len() - 1
        }
    };
    out.get_mut(i)
}

fn add_text(u: &mut UsedFont, text: &str) {
    for c in text.chars().filter(|c| !c.is_whitespace()) {
        if u.chars.chars().count() >= MAX_CHARS {
            return;
        }
        if !u.chars.contains(c) {
            u.chars.push(c);
        }
    }
}

fn body_fonts(ctx: &Ctx, s: &Shape, body: &TextBody, out: &mut Vec<UsedFont>) {
    for para in &body.paragraphs {
        let runs: Vec<_> = para.runs.iter().filter(|r| !r.text.trim().is_empty()).collect();
        if runs.is_empty() {
            continue;
        }
        for run in runs {
            let r = resolve::run(ctx, s, para, &run.props);
            let family = resolve::font_family(ctx, &r);
            let hint = resolve::font_hint(ctx, &r, &family).cloned();
            let Some(u) = entry(out, &family) else { continue };
            u.styles.insert((r.bold.unwrap_or(false), r.italic.unwrap_or(false)));
            if u.hint.is_none() {
                u.hint = hint;
            }
            add_text(u, &run.text);
        }
        let pp = resolve::para(ctx, s, para);
        if let Some(Bullet::Char { char: ch }) = &pp.bullet
            && let Some(f) = pp.bullet_font.as_deref()
            && let Some(u) = entry(out, &ctx.master.theme.font(f))
        {
            u.styles.insert((false, false));
            add_text(u, ch);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::defaults;
    use crate::text::{Bullet, Run};

    fn deck(runs: Vec<Run>) -> Presentation {
        let mut p = defaults::new_presentation(None);
        let mut body = TextBody::from_text("");
        body.paragraphs[0].runs = runs;
        let shape = Shape { name: "Text".into(), text: Some(body), ..Default::default() };
        Arc::make_mut(&mut p.slides[0]).shapes.push(shape);
        p
    }

    fn run(text: &str, font: &str, bold: bool, italic: bool) -> Run {
        let mut r = Run::new(text);
        r.props.font = Some(font.into());
        r.props.bold = Some(bold);
        r.props.italic = Some(italic);
        r
    }

    fn find<'a>(used: &'a [UsedFont], family: &str) -> &'a UsedFont {
        used.iter().find(|u| u.family == family).unwrap_or_else(|| panic!("{family} not in {used:?}"))
    }

    #[test]
    fn a_family_lists_the_styles_it_is_used_in() {
        let used = used_fonts(&deck(vec![run("Bold ", "Lato", true, false), run("italic", "lato", false, true)]));
        let lato = find(&used, "Lato");
        assert_eq!(lato.styles, BTreeSet::from([(true, false), (false, true)]));
        assert_eq!(used.iter().filter(|u| u.family.eq_ignore_ascii_case("lato")).count(), 1);
    }

    #[test]
    fn a_family_keeps_the_characters_it_draws() {
        let used = used_fonts(&deck(vec![run("日本 語 日", "Lato", false, false)]));
        assert_eq!(find(&used, "Lato").chars, "日本語");
    }

    #[test]
    fn theme_references_and_their_hints_resolve() {
        let mut p = deck(vec![run("Title", "+mj-lt", false, false)]);
        let m = Arc::make_mut(&mut p.masters[0]);
        m.theme.fonts.major.latin = "Brand Display".into();
        m.theme.fonts.major.latin_hint = Some(FontHint { typeface: "Brand Display".into(), panose: None, pitch_family: Some(18) });
        let used = used_fonts(&p);
        assert_eq!(find(&used, "Brand Display").hint.as_ref().and_then(|h| h.pitch_family), Some(18));
    }

    #[test]
    fn a_hint_for_another_typeface_is_dropped() {
        let mut r = run("Text", "Foo Serif", false, false);
        r.props.font_hint = Some(FontHint { typeface: "Old Name".into(), panose: None, pitch_family: Some(18) });
        assert_eq!(find(&used_fonts(&deck(vec![r])), "Foo Serif").hint, None);
    }

    #[test]
    fn bullet_fonts_count_and_empty_runs_do_not() {
        let mut p = deck(vec![run("Item", "Lato", false, false), run("   ", "Ghost Font", false, false)]);
        let s = Arc::make_mut(&mut p.slides[0]).shapes.iter_mut().find(|s| s.name == "Text").expect("text shape");
        let para = &mut s.text.as_mut().expect("body").paragraphs[0];
        para.props.bullet = Some(Bullet::Char { char: "§".into() });
        para.props.bullet_font = Some("Wingdings".into());
        let used = used_fonts(&p);
        assert_eq!(find(&used, "Wingdings").chars, "§");
        assert!(!used.iter().any(|u| u.family == "Ghost Font"));
    }
}
