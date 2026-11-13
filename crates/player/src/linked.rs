//! Linked pictures: pictures whose bytes live outside the deck (Insert > Picture > Link to File, or
//! a deck whose large pictures a media service moved out of the copy viewers download).
//!
//! The deck names a URL; the player never fetches anything. It lists the linked pictures each
//! slide of the show uses ([`Player::linked_images`], [`Player::slide_linked_images`]), offers
//! only those under the host's media prefix for fetching ([`Player::linked_images_under`],
//! [`media_url`]), and takes the bytes the host fetched ([`Player::set_linked_image`]). A picture
//! without bytes draws nothing, as an unreadable embedded picture does.

use std::collections::HashSet;
use std::sync::Arc;

use deckcraft_model::media_refs::visit;
use deckcraft_model::{MediaId, Presentation, Shape, ShapeKind, Slide};

use crate::Player;

/// Most linked pictures listed for a deck: each one is a download for every viewer.
pub const MAX_LINKED_IMAGES: usize = 512;
/// Largest linked picture accepted, in encoded bytes.
pub const MAX_LINKED_IMAGE_BYTES: usize = 32 << 20;
/// Most encoded bytes of linked pictures one deck holds at once.
pub const MAX_LINKED_TOTAL_BYTES: usize = 256 << 20;
/// Longest URL offered for fetching.
pub const MAX_MEDIA_URL_LEN: usize = 2048;

/// A picture of the show whose bytes live outside the deck.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedImage {
    pub media: MediaId,
    /// The link as the deck writes it ([`Player::linked_images`]), or the URL to fetch, under
    /// the media prefix ([`Player::linked_images_under`]).
    pub url: String,
    /// From the link's file extension; `application/octet-stream` when it has none.
    pub content_type: String,
    /// The show's slides (indexes into the presentation, as [`crate::Pos::slide`]) that draw it,
    /// through their own shapes, background, fills and bullets, or their layout's and master's.
    pub slides: Vec<usize>,
    /// Its bytes were set ([`Player::set_linked_image`]).
    pub loaded: bool,
}

/// Why [`Player::set_linked_image`] refused bytes. `Display` gives a short code for hosts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum LinkedImageError {
    /// Not a linked picture of this deck's show.
    #[error("unknown")]
    Unknown,
    /// More than [`MAX_LINKED_IMAGE_BYTES`].
    #[error("too-large")]
    TooLarge,
    /// The deck's linked pictures would hold more than [`MAX_LINKED_TOTAL_BYTES`].
    #[error("deck-budget")]
    DeckBudget,
    /// Not a picture format the renderer reads, or larger than it draws.
    #[error("undecodable")]
    Undecodable,
}

/// The deck's linked pictures, found once when it opens.
#[derive(Clone, Debug, Default)]
pub(crate) struct Linked {
    images: Vec<LinkedImage>,
    /// Encoded bytes set so far.
    bytes: usize,
}

impl Linked {
    /// The linked pictures the show's slides (`order`) use, in order of first use.
    pub(crate) fn find(pres: &Presentation, order: &[usize]) -> Linked {
        let not_pictures = not_pictures(pres);
        let mut images: Vec<LinkedImage> = Vec::new();
        for &i in order {
            let Some(slide) = pres.slides.get(i) else { continue };
            for id in slide_refs(pres, slide) {
                if let Some(img) = images.iter_mut().find(|m| m.media == id) {
                    if !img.slides.contains(&i) {
                        img.slides.push(i);
                    }
                    continue;
                }
                if images.len() >= MAX_LINKED_IMAGES || not_pictures.contains(&id) {
                    continue;
                }
                let Some(item) = pres.media(id) else { continue };
                let Some(url) = item.link.as_ref() else { continue };
                let ct = item.content_type.as_str();
                if ct.starts_with("audio/") || ct.starts_with("video/") {
                    continue;
                }
                images.push(LinkedImage { media: id, url: url.clone(), content_type: item.content_type.clone(), slides: vec![i], loaded: false });
            }
        }
        Linked { images, bytes: 0 }
    }
}

impl Player {
    /// The linked pictures the show's slides use, each once, in order of first use, at most
    /// [`MAX_LINKED_IMAGES`]. `url` is the link as the deck writes it: a host must not fetch it
    /// as it is ([`Player::linked_images_under`]).
    pub fn linked_images(&self) -> Vec<LinkedImage> {
        self.linked.images.clone()
    }

    /// The linked pictures a host may fetch: those whose link is an `https` URL under `base` (the
    /// host's media prefix, [`media_url`]), with `url` normalised. Links elsewhere, `file:` paths
    /// included, are left out and never drawn.
    pub fn linked_images_under(&self, base: &str) -> Vec<LinkedImage> {
        self.linked.images.iter().filter_map(|m| Some(LinkedImage { url: media_url(&m.url, base)?, ..m.clone() })).collect()
    }

    /// The linked pictures slide `slide` draws (shapes, background, fills, bullets, its layout's
    /// and master's), by media id.
    pub fn slide_linked_images(&self, slide: usize) -> Vec<MediaId> {
        self.linked.images.iter().filter(|m| m.slides.contains(&slide)).map(|m| m.media).collect()
    }

    /// Give a linked picture its bytes, fetched by the host. They are checked from their header
    /// against the limits every picture is drawn within, and decoded when drawn, as an embedded
    /// picture's. Setting them again replaces them. Returns whether the slide on screen draws the
    /// picture: its next [`Player::frame`] then draws it.
    pub fn set_linked_image(&mut self, media: MediaId, bytes: Vec<u8>) -> Result<bool, LinkedImageError> {
        let Some(k) = self.linked.images.iter().position(|m| m.media == media) else { return Err(LinkedImageError::Unknown) };
        if bytes.len() > MAX_LINKED_IMAGE_BYTES {
            return Err(LinkedImageError::TooLarge);
        }
        let Some(item) = self.pres.media.iter_mut().find(|m| m.id == media) else { return Err(LinkedImageError::Unknown) };
        let total = self.linked.bytes.saturating_sub(item.data.len()).saturating_add(bytes.len());
        if total > MAX_LINKED_TOTAL_BYTES {
            return Err(LinkedImageError::DeckBudget);
        }
        if !deckcraft_render::image_decodable(&bytes) {
            return Err(LinkedImageError::Undecodable);
        }
        // New bytes are a new allocation: the renderer's caches, keyed by the bytes' address,
        // never mistake them for the empty bytes that failed to draw before.
        item.data = Arc::new(bytes);
        self.linked.bytes = total;
        let on_screen = match self.linked.images.get_mut(k) {
            Some(img) => {
                img.loaded = true;
                img.slides.contains(&self.pos.slide)
            }
            None => false,
        };
        if on_screen {
            self.shown = None;
        }
        Ok(on_screen)
    }
}

/// `url` as a host may fetch it for a deck: an `https` URL under `base`, the host's media prefix
/// (`https://host/path/`; a missing final `/` is added). The scheme and host compare without case.
/// Refused: anything else, `file:` and relative links included; user names and passwords; dot
/// segments, encoded or not; encoded slashes and backslashes; backslashes, spaces and control
/// characters; URLs longer than [`MAX_MEDIA_URL_LEN`]. A fragment is dropped.
pub fn media_url(url: &str, base: &str) -> Option<String> {
    let (origin, prefix) = media_base(base)?;
    let url = url.split('#').next().unwrap_or_default();
    if url.len() > MAX_MEDIA_URL_LEN || !url.bytes().all(|b| b.is_ascii_graphic() && b != b'\\') {
        return None;
    }
    // The origin ends where the prefix's path starts, with a `/`: `https://cdn.example` can't
    // match `https://cdn.example.evil/`.
    if !url.get(..origin.len())?.eq_ignore_ascii_case(&origin) {
        return None;
    }
    let rest = url.get(origin.len()..)?.strip_prefix(prefix.as_str())?;
    if rest.is_empty() {
        return None;
    }
    let path = rest.split('?').next().unwrap_or_default();
    let lower = path.to_ascii_lowercase();
    if ["%2e", "%2f", "%5c"].iter().any(|bad| lower.contains(bad)) || path.split('/').any(|seg| seg == "." || seg == "..") {
        return None;
    }
    Some(format!("{origin}{prefix}{rest}"))
}

/// A media prefix normalised, as its origin (`https://host`, lowercased) and its path (from `/`,
/// ending in `/`): no user name or password, query, fragment or dot segment.
fn media_base(base: &str) -> Option<(String, String)> {
    let base = base.trim();
    if base.len() > MAX_MEDIA_URL_LEN || !base.bytes().all(|b| b.is_ascii_graphic() && b != b'\\') || base.contains(['?', '#']) {
        return None;
    }
    let scheme = base.get(..8)?;
    if !scheme.eq_ignore_ascii_case("https://") {
        return None;
    }
    let after = base.get(8..)?;
    let (host, path) = after.split_once('/').unwrap_or((after, ""));
    if host.is_empty() || host.contains('@') || host.starts_with(':') {
        return None;
    }
    if path.to_ascii_lowercase().contains("%2e") || path.split('/').any(|seg| seg == "." || seg == "..") {
        return None;
    }
    let slash = if path.is_empty() || path.ends_with('/') { "" } else { "/" };
    Some((format!("https://{}", host.to_ascii_lowercase()), format!("/{path}{slash}")))
}

/// Every media id a slide may draw: its own references and its layout's and master's (theme,
/// shapes, background, text styles; not the master's other layouts).
fn slide_refs(pres: &Presentation, slide: &Slide) -> Vec<MediaId> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut f = |id: &MediaId| {
        if seen.insert(*id) {
            out.push(*id);
        }
    };
    visit::slide(slide, &mut f);
    if let Some((master, layout)) = pres.master_for(slide) {
        if let Some(l) = layout {
            visit::layout(l, &mut f);
        }
        visit::theme(&master.theme, &mut f);
        visit::shapes(&master.shapes, &mut f);
        visit::background(&master.background, &mut f);
        visit::list(&master.title_style, &mut f);
        visit::list(&master.body_style, &mut f);
        visit::list(&master.other_style, &mut f);
    }
    out
}

/// Media the deck uses as something other than a picture: clips, 3-D models, the parts of objects
/// it keeps unmodelled, and embedded fonts. A poster or a preview is a picture.
fn not_pictures(pres: &Presentation) -> HashSet<MediaId> {
    fn walk(shapes: &[Shape], out: &mut HashSet<MediaId>, depth: usize) {
        if depth > 64 {
            return;
        }
        for s in shapes {
            match &s.kind {
                ShapeKind::Media(clip) => {
                    out.insert(clip.media);
                }
                ShapeKind::Model3d { media, .. } => {
                    out.insert(*media);
                }
                ShapeKind::Opaque { parts, .. } => out.extend(parts.iter().map(|(_, _, id)| *id)),
                ShapeKind::Group { children, .. } => walk(children, out, depth + 1),
                _ => {}
            }
        }
    }
    let mut out = HashSet::new();
    for s in &pres.slides {
        walk(&s.shapes, &mut out, 0);
    }
    for m in &pres.masters {
        walk(&m.shapes, &mut out, 0);
        for l in &m.layouts {
            walk(&l.shapes, &mut out, 0);
        }
    }
    for e in &pres.embedded_fonts {
        out.extend(e.faces().into_iter().flatten());
    }
    out
}
