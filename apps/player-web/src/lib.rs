//! [`deckcraft_player`] for the browser. `js/worker.js` loads this module in a Web Worker and
//! drives it; positions cross the boundary as `[slide, step]` arrays.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(target_arch = "wasm32")]
pub use web::WebPlayer;
