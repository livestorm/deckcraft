//! Each slide keeps the id it had in the file (`p:sldId id`): a deck and a copy of it with slides
//! removed (the browser player's attendee copy) still agree on which slide is which, though their
//! indexes differ.

use std::io::{Cursor, Read, Write};
use std::sync::Arc;

use deckcraft_model::{Presentation, defaults};

/// A three-slide deck saved by DeckCraft (ids 256, 257, 258) with its ids replaced by `ids`.
fn deck_with_ids(ids: [u32; 3]) -> Vec<u8> {
    let mut p = defaults::new_presentation(None);
    let layout = p.slides[0].layout;
    for _ in 0..2 {
        let s = defaults::new_slide(&mut p, layout).expect("slide");
        p.slides.push(Arc::new(s));
    }
    let bytes = deckcraft_pptx::export(&p).expect("export");
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let o = zip::write::SimpleFileOptions::default();
    for i in 0..z.len() {
        let mut f = z.by_index(i).expect("entry");
        let name = f.name().to_string();
        let mut d = vec![];
        f.read_to_end(&mut d).expect("read");
        if name == "ppt/presentation.xml" {
            let mut xml = String::from_utf8(d).expect("utf8");
            for (k, id) in ids.iter().enumerate() {
                xml = xml.replacen(&format!(r#"<p:sldId id="{}""#, 256 + k), &format!(r#"<p:sldId id="X{id}""#), 1);
            }
            d = xml.replace(r#"<p:sldId id="X"#, r#"<p:sldId id=""#).into_bytes();
        }
        out.start_file(name, o).expect("start");
        out.write_all(&d).expect("write");
    }
    out.finish().expect("finish").into_inner()
}

fn file_ids(p: &Presentation) -> Vec<Option<u32>> {
    p.slides.iter().map(|s| s.file_id).collect()
}

#[test]
fn slides_keep_the_ids_they_had_in_the_file() {
    let p = deckcraft_pptx::import(&deck_with_ids([256, 300, 412])).expect("import");
    assert_eq!(file_ids(&p), [Some(256), Some(300), Some(412)]);
}

#[test]
fn slides_made_in_deckcraft_have_no_file_id() {
    let p = defaults::new_presentation(None);
    assert_eq!(file_ids(&p), [None]);
}
