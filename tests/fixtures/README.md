# L6 media fixtures

These files are deterministic, synthetic inputs for the browser tests. They contain no
private or user-supplied media.

Regenerate them with:

```bash
npm run fixtures:generate
```

The generator uses the local `ffmpeg` executable for the two video containers and Node's
standard library for the transparent PNG, baseline TIFF, and malformed input. The video
commands use `lavfi` `testsrc2`/`color` and a fixed `aevalsrc` audio event, fixed dimensions, fixed durations,
fixed frame rates, fixed codec settings, and a fixed source metadata marker. The source
comment marker is `omc-l6-source-marker`; tests assert that the marker and any output
chapters do not survive compression. `fixture-metadata.txt` is an input to the rotated
video fixture and records the chapter metadata that compression must strip.

The generated files are intentionally small and may be inspected with `ffprobe`:

```bash
ffprobe -v error -show_streams -show_format tests/fixtures/audio-24fps.webm
ffprobe -v error -show_streams -show_format tests/fixtures/silent-29.97fps-rotated.mp4
```

The fixtures are regenerated only when the generator or its documented inputs change.
They are not downloaded from the internet.
