# firefly-audio-video

Node/TypeScript client for Adobe Firefly Services' audio/video (Dynamic Graphics Render, DGR) API.
It wraps the submit/poll render and describe endpoints behind promises that resolve with the
finished asset, authors `.epr` presets natively from a JSON-first config, redacts credentials and
signed-URL secrets from every log line and error, and ships an `npx`-able CLI (`dgr`) alongside the
library so agents and humans share one surface.
