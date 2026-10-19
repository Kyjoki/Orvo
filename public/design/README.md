# Extracted design assets

These assets come from the user-supplied `Orvo-Pixel-Office-Seated.html`. They are source assets, not an embedded export or a new design.

- `office.svg`: original 1000×600 pixel office. Dynamic binding syntax and status bubbles removed; static six seated characters remain.
- `office-background.svg`: original office room, plants, meeting area, lounge, cat; the five workstation groups and six character groups removed for dynamic placement.
- `workstation-1.svg` … `workstation-6.svg`: original monitor/desk/chair plus one original seated character, viewBox `-72 -76 144 168`. Repeat variants as required; labels/status controls must be separate application UI.
- `empty-workstation-1.svg` … `empty-workstation-6.svg`: the same desks, monitors and chairs without characters. Vacant places remain visible even when no agents exist.
- `workstation-working-1.svg` … `workstation-working-6.svg`: original seated characters with animated hands, head and monitor text. Used only for a server-reported running task; respects reduced motion. Regenerate with `node scripts/workstation-animation.mjs`.
- `person-1.svg` … `person-6.svg`: original characters, viewBox `-30 -65 60 100`.
- `icons.svg`: original icon symbols.
- `tokens.css`: original dark/light theme variables.
- `fonts.css`, `fonts/`: supplied local font subsets. Golos Text for UI; Unbounded for display; JetBrains Mono for code/numbers. See `FONT-LICENSES.txt`.
- `01-reference.html` … `09-reference.html` and matching CSS: static extracted design source for comparison. Design-export scripts and framework code have been removed. These references still contain original illustrative labels; the product should use application state and its actual agents.
- `index.json`: nine source screen titles and files.

Original office placement: desk centers `(220,204)`, `(420,204)`, `(620,204)`, `(220,380)`, `(420,380)`; seated people are 52px below each desk center. Sixth original character sits at meeting table `(815,444)`.

Regenerate from the authorized local source with `node scripts/extract-design.mjs [absolute source path]`. Extraction does not execute source scripts or fetch resources. The wrapper and original design runtime are not used in the product.
