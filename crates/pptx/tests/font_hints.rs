//! `panose` and `pitchFamily` on `a:latin` (runs and theme fonts) survive open → save → reopen.
//! The browser player uses them to draw a missing font as a serif, sans or monospace stand-in.

use std::sync::Arc;

use deckcraft_model::text::{FontHint, TextBody};
use deckcraft_model::{Presentation, defaults};

fn hint(typeface: &str, panose: &str, pitch_family: u8) -> FontHint {
    FontHint { typeface: typeface.into(), panose: Some(panose.into()), pitch_family: Some(pitch_family) }
}

fn deck_with_run_hint() -> Presentation {
    let mut p = defaults::new_presentation(None);
    let mut shape = deckcraft_model::Shape {
        id: deckcraft_model::ShapeId(p.alloc_id().expect("id")),
        name: "Text".into(),
        xfrm: Some(deckcraft_geom::Xfrm::new(0.0, 0.0, 300.0, 100.0)),
        text: Some(TextBody::from_text("Serif text")),
        ..Default::default()
    };
    let body = shape.text.as_mut().expect("text box has a body");
    let run = &mut body.paragraphs[0].runs[0].props;
    run.font = Some("Old Foundry Serif".into());
    run.font_hint = Some(hint("Old Foundry Serif", "02020603050405020304", 18));
    Arc::make_mut(&mut p.slides[0]).shapes.push(shape);
    let m = Arc::make_mut(&mut p.masters[0]);
    m.theme.fonts.major.latin = "Brand Display".into();
    m.theme.fonts.major.latin_hint = Some(hint("Brand Display", "020B0604020202020204", 34));
    p
}

fn text_run(p: &Presentation) -> &deckcraft_model::text::RunProps {
    let shape = p.slides[0].shapes.iter().find(|s| s.name == "Text").expect("the text shape");
    &shape.text.as_ref().expect("its body").paragraphs[0].runs[0].props
}

fn round_trip(p: &Presentation) -> Presentation {
    deckcraft_pptx::import(&deckcraft_pptx::export(p).expect("export")).expect("reimport")
}

#[test]
fn run_font_hints_round_trip() {
    let q = round_trip(&deck_with_run_hint());
    let run = text_run(&q);
    assert_eq!(run.font.as_deref(), Some("Old Foundry Serif"));
    assert_eq!(run.font_hint, Some(hint("Old Foundry Serif", "02020603050405020304", 18)));
}

#[test]
fn theme_font_hints_round_trip() {
    let q = round_trip(&deck_with_run_hint());
    assert_eq!(q.masters[0].theme.fonts.major.latin_hint, Some(hint("Brand Display", "020B0604020202020204", 34)));
}

#[test]
fn a_hint_for_another_typeface_is_not_written() {
    let mut p = deck_with_run_hint();
    let shape = Arc::make_mut(&mut p.slides[0]).shapes.iter_mut().find(|s| s.name == "Text").expect("text shape");
    shape.text.as_mut().expect("body").paragraphs[0].runs[0].props.font = Some("Another Font".into());
    let q = round_trip(&p);
    let run = text_run(&q);
    assert_eq!(run.font.as_deref(), Some("Another Font"));
    assert_eq!(run.font_hint, None);
}
