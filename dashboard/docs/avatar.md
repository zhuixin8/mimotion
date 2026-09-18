# Virtual athlete

The approved short-haired male avatar appears in the signed-in Overview and Plan pages. A single canvas moves between those pages. It does not appear in login, administration, records, or payment/activation forms.

The saved plan and existing runtime response determine presentation: enabled plans breathe gently while waiting, a freshly observed running submission runs, and paused/expired/suspended/disconnected accounts show a still pose. A manual task can run while its automatic plan is paused. Missing or stale runtime data shows a waiting state. Animation never certifies step submission or WeChat synchronization.

No account API or Zepp request is added by the avatar. The viewer and embedded-texture model are loaded lazily from versioned same-origin URLs and cached. No external CDN, analytics, or runtime model service is used. Frame rate is capped at 30 FPS with device pixel ratio capped at 1.5. Hidden tabs, offscreen cards, and unrelated views stop rendering. The figure sits inside the Overview runtime card (160px stage) and beside the Plan countdown (112px stage), with no independent banner or repeated status copy. Mobile starts with a still pose and offers an explicit play button. Users may pause the animation independently of their plan, and the system reduced-motion preference is respected. Rendering failure leaves normal controls and status text usable.

`npm run build` bundles `src/avatar.js` (Three.js 0.180.0) into a text module, then builds the Worker. `src/avatar-model.js` contains the optimized, gzip-compressed GLB as base64 with walk/run/idle clips. `docs/avatar-license.txt` records model provenance and licenses; the same text is served at `/athlete-license.txt`. The source FBX is from VALID's `Asian_M_1_Casual` asset and motion was retargeted from the Three.js r180 Xbot example. Future model or viewer changes must bump their public versioned URLs.

Validation: automated presentation-state and static-asset route tests; full existing test suite; desktop/mobile fake-account browser checks. UI checks must not submit steps or refresh Zepp credentials.
