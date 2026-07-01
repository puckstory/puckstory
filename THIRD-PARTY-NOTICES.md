# Third-party notices

Puckstory builds to a single self-contained file (`puckstory.html`) with the following third-party
components inlined. Each stays under its own license; this file carries the copyright and
permission notices those licenses require to accompany redistributed copies.

## Font (bundled in the build)

- **Inter** by Rasmus Andersson - [SIL Open Font License 1.1](https://openfontlicense.org).
  Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter).
  Vendored as `src/fonts/inter-latin.woff2` (Latin subset) and inlined as base64 at build time.
  This Font Software is licensed under the SIL Open Font License, Version 1.1; the full license
  text is available at https://openfontlicense.org and in the Inter repository.

## Libraries (redistributed in the bundle)

| Component | License | Copyright |
|---|---|---|
| Svelte | MIT | Copyright (c) 2016-23 [Svelte contributors](https://github.com/sveltejs/svelte/graphs/contributors) |
| d3-force, d3-selection, d3-zoom | ISC | Copyright 2010-2021 Mike Bostock |

### MIT License (Svelte)

> Copyright (c) 2016-23 Svelte contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### ISC License (d3-force, d3-selection, d3-zoom)

> Copyright 2010-2021 Mike Bostock
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without
> fee is hereby granted, provided that the above copyright notice and this permission notice appear
> in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
> SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
> AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
> NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
> OF THIS SOFTWARE.

## Build-only tooling (not shipped in `puckstory.html`)

Vite, vite-plugin-singlefile, TypeScript, vitest, and Playwright produce and test the build. **graphology**
and **graphology-communities-louvain** (MIT, Copyright (c) 2016-2021 Guillaume Plique) run only in
the data pipeline (`data-pipeline/communities.mjs`) to precompute the dynasty communities baked
into the dataset - since v2 they are no longer redistributed in the bundle.

## Data and artwork

The dataset (`src/data/dataset.json`) and the traced Stanley Cup / Conn Smythe silhouettes are
derived from Wikipedia and a Wikimedia Commons photograph and are licensed **CC BY-SA 4.0**. See the
"License" section of [README.md](./README.md) for the attribution and details.
