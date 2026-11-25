# FocusTube Walkthroughs

Open the [local viewing page](index.html) or use the MP4 files below. These are local deliverables, not published Loom links.

These recordings are included in the [2026-10-15 publication candidate](../v1-release.md#publication-candidate-2026-10-15). They show the earlier released snapshot identified below, not the newer cache/admin-budget controls. The motion treatment is video post-production, not new in-app animation. Original recordings remain alongside the motion editions for reference.

Use a regular browser for the viewing page. VS Code's integrated local-file preview aborted MP4 loading, while the same files passed native Chrome playback and seeking checks.

| Motion Edition | Duration | Chapters | Captions |
| --- | --- | --- | --- |
| [Feature tour](focustube-feature-tour-motion.mp4) | 10:03 | 19 | [SRT](focustube-feature-tour-motion.srt), [WebVTT](focustube-feature-tour-motion.vtt) |
| [Architecture and design choices](focustube-architecture-motion.mp4) | 7:42 | 12 | [SRT](focustube-architecture-motion.srt), [WebVTT](focustube-architecture-motion.vtt) |

## Presentation

- Smooth, bounded focus zooms with holds on the demonstrated feature, then returns to the overview. Task/certificate dialogs use curated framing; dashboards and monitoring retain their wider context.
- Visible pointer highlights and click rings from real browser input events in the isolated demo.
- Animated chapter titles and progress ribbon, consistent 1080p framing, fixed two-line captions, and normalized English synthetic narration.
- The feature tour contains 43 guided focus moves and 102 click cues; the architecture tour contains 16 guided focus moves and 20 click cues. Recorded camera plans are in [feature motion data](focustube-feature-tour-motion.motion.json) and [architecture motion data](focustube-architecture-motion.motion.json).
- The original MP4s are retained. Use the `-motion` editions as the current deliverables.

## Scope

The recordings use release `15add2abd3b5606371055dc2b19575ed5dac8be5`, synthetic accounts, original demonstration media, and disposable databases. YouTube, email, AI responses, and browser-extension connection/save receipts are simulated. No live learner records, private notes, real invitation links, provider keys, or paid provider calls were used.

The feature tour covers signup, verification, library filters, discovery, playback, lessons, chapters, notes, notebook export, tasks, roadmaps, dashboards, chat and note append, settings/data controls, feedback, invitations/moderation, monitoring/optional analytics, the extension popup, and certificates. Some limits and recovery behaviors are described rather than deliberately triggered. Native permission/print dialogs and live provider behavior are not demonstrated as verified. Optional features being enabled in the disposable demo does not enable them on a real installation.

The architecture recording reuses the validated [Archify diagram](architecture.html) and its [source specification](architecture.architecture.json). Node focus, relationships, and trace motion are explanatory, not live traffic. It distinguishes released behavior from newer uncommitted cache work and other proposals. See the [narration scripts](walkthroughs.json) for the complete coverage and caveats.

## Verification

The motion editions were checked for H.264/AAC playback format, 1920x1080 at 25fps, complete decoding, unclipped narration, chapter markers, caption timing, nonblank chapter frames, and bounded camera crops at every output frame. Focused frame samples were compared against the raw captures. Their source clocks differ from the original browser timestamps by less than 0.1 seconds. Long caption sentences use proportional word timing inside measured sentence audio.

Native Chrome playback and seeking passed for both files. The viewing page fits 1440, 768, and 375 CSS-pixel widths. Visual review covered every chapter's contact-sheet sample and full-size checks of the corrected task, certificate, and monitoring shots; it was not a frame-by-frame human review of both complete videos.

Chapter contact sheets: [feature tour](focustube-feature-tour-motion.contact-sheet.jpg) and [architecture](focustube-architecture-motion.contact-sheet.jpg). The [motion verification receipt](verification-motion.json) records the final file hashes and exact verification scope. These checks are video-production checks, not a new application test-suite run or hosted deployment audit.