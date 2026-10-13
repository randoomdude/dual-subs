# Dual Subtitles for Seanime

**Version 1.4.2** · Seanime Denshi 3.10.3 · built-in VideoCore player

Dual Subtitles keeps Seanime's regular subtitle track in place and displays a second text track in the player. It is useful for reading Japanese alongside English.

## Features

- Choose an embedded track, a file added through Subtitle Engine/Jimaku, or a local ASS, SSA, SRT, or VTT file.
- Automatically select an available Japanese track.
- Set the second track's position, spacing, size, and independent delay.
- Optionally match the second track's timing to dialogue in the episode and load a Japanese-capable font for native subtitles.
- Recover missing cues from an embedded text track after loading or seeking. Recovery preserves Seanime's original cue timing and styling and does not change the selected track.
- Control the extension from **Tray Plugins → Dual Subtitles**.

## Install

1. Download the [installable extension manifest](https://raw.githubusercontent.com/randoomdude/dual-subs/main/local-dual-subtitles.json).
2. Put the JSON file in the `extensions` folder inside Seanime's data directory.
3. Enable Dual Subtitles in Seanime and approve its playback and UI-script permission prompts.
4. Start an episode, keep English selected in Seanime's normal subtitle menu, then open **Tray Plugins → Dual Subtitles** and choose the second track.
5. If the extension starts after playback has already begun, select the main subtitle track once in Seanime's normal menu so the extension can connect to the active subtitle manager.

If the episode has no Japanese track, add one with Subtitle Engine/Jimaku or use the local-file control in the extension panel. The main subtitle remains controlled by Seanime's regular subtitle menu.

## Files

- `local-dual-subtitles.json` — installable Seanime extension.
- `dual-subtitles.js` — readable JavaScript source.

## Compatibility and limitations

This version targets Seanime Denshi 3.10.3's built-in VideoCore player. Seanime updates may change the internal player interfaces used by the extension.

The second layer is intended for text subtitles. Bitmap tracks such as PGS/VobSub cannot be displayed as the second learning track, and advanced ASS positioning, drawings, and karaoke effects are simplified there. The main subtitle keeps Seanime's native rendering.

Automatic timing needs enough matching dialogue in an embedded text track and may not find a reliable match for every release. Missing-cue recovery is best effort: it can only restore cues Seanime has delivered for the selected embedded text track. It does not repair missing server data, external-file main tracks, bitmap tracks, translated tracks, or a failed renderer. The extension does not modify Seanime's executable.
