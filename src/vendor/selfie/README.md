# Selfie segmentation model

`selfie.json` + `selfie.bin`: MediaPipe Selfie Segmentation (general model,
256 x 256), by Google, licensed Apache-2.0. Converted to a TensorFlow.js graph
model by PINTO0309 (PINTO_model_zoo, 109_Selfie_Segmentation, MIT) and
Vladimir Mandic (@vladmandic/human-models 3.0.4, MIT), copied unchanged.

Used by `src/ui/portraitVision.ts` as the local fallback for a portrait's
subject mask (Pro portrait styles), when the server's smart cut-out is not
used. Loaded only when a Pro member picks a portrait style.
