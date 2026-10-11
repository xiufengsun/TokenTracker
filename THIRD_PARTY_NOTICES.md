# Third-Party Notices

This project includes third-party assets and code. The following notices apply.

## RunCat menu bar cat frames

The running-cat animation frames used by the macOS menu bar icon
(`TokenTrackerBar/TokenTrackerBar/Assets.xcassets/RunnerCat0…4.imageset`)
are from [menubar_runcat](https://github.com/Kyome22/menubar_runcat)
by Takuto Nakamura (Kyome22).

Copyright © 2019 Takuto Nakamura

Licensed under the Apache License, Version 2.0 (the "License");
you may not use these files except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

## Bot companion morphing engine

The vector morphing engine behind the `bot` pet character and its menu bar icon
(`dashboard/src/lib/bot/`, and the frame data generated from it by
`scripts/gen-bot-frames.cjs`) is from [bloub](https://github.com/jeremy-prt/bloub)
by Jérémy Perret, vendored unmodified at commit
[`b4bb3c1b5f93`](https://github.com/jeremy-prt/bloub/tree/b4bb3c1b5f93c7b87a2e8d620f667c4093d97749).

Note when re-vendoring: `dashboard/src/lib/bot/README.md` is ours, not upstream's, and
`decor.ts` / `skins.ts` are listed in `scripts/ops/ui-hardcode-baseline.json`, so a
refresh needs that file re-copied and the baseline regenerated.

Copyright © 2026 Jérémy Perret

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Devin brand mark

`dashboard/public/brand-logos/devin.svg` is a monochrome vector trace of the
official Devin "nodes" mark published by Cognition at
`https://app.devin.ai/assets/pwa/apple-touch-icon.png` (also
`https://app.devin.ai/assets/pwa/pwa-icon-192.png`). The Devin name and logo
are trademarks of Cognition; the mark is bundled solely to identify the Devin
CLI source and subscription quota in the dashboard, recoloured to `currentColor` like the
other provider marks.

## Hairline line figures

The Cloud plan page uses [Hairline](https://github.com/lucasmarkes/hairline) v0.5.0 by Lucas Marques.

MIT License

Copyright (c) 2026 Lucas Marques

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
