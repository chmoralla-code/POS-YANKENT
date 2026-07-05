'use strict';
/* Append the new product list to product-catalog.json. */
const fs = require('fs');
const path = require('path');

const catalogPath = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'product-catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

// [name, baseUnit] pairs from the client's list.  Category is inferred
// from product type.  All items get ₱0 price / 0 stock — cashier edits later.
const newItems = [
  // 2762
  ['Def. Bar 12mm G-33', 'pcs', 'G.I. & Steel'],
  ['Def. Bar 10mm G-33', 'pcs', 'G.I. & Steel'],
  ['Def. Bar 16mm G-33', 'pcs', 'G.I. & Steel'],
  ['M/S Gloss Latex White (Gal-4/1)', 'tins', 'Paint'],
  ['Pioneer All Purpose Epoxy 1/4 ltr', 'cans', 'Adhesives & Sealants'],
  ['Pioneer All Purpose Epoxy 1/2 ltr', 'cans', 'Adhesives & Sealants'],
  // 2763
  ['Pioneer All Purpose Epoxy 1/2 ltr (set)', 'set', 'Adhesives & Sealants'],
  ['M/S Gloss Latex White', 'gal.', 'Paint'],
  ['Marine Plywood 3/16 4mm', 'shts', 'Lumber & Boards'],
  ['Marine Plywood 1/2 10mm', 'shts', 'Lumber & Boards'],
  ['Island Slimcoat Powder', 'bags', 'Cement & Aggregates'],
  ['ABC Tile Adhesive Original', 'bags', 'Adhesives & Sealants'],
  // 2764
  ['G.I. Rect. Tube 1x2 1.5mm', 'pcs', 'G.I. & Steel'],
  ['Def. Bar 10mm G-33 (2764)', 'pcs', 'G.I. & Steel'],
  ['Sahara 900g', 'ctn', 'Adhesives & Sealants'],
  // 2765
  ['Angle Bar 3/16 x 1 1/2 w/ logo', 'pcs', 'G.I. & Steel'],
  ['Angle Bar 3/16 x 1 w/ logo', 'pcs', 'G.I. & Steel'],
  ['Flat Bar 3/16 x 1 6.0mm', 'pcs', 'G.I. & Steel'],
  ['Def. Bar 10mm G-33 (2765)', 'pcs', 'G.I. & Steel'],
  // 2766
  ['Atlanta PVC Clean Out 4', 'pcs', 'Plumbing'],
  // 2767
  ['Marine Plywood 1/2 (10mm)', 'shts', 'Lumber & Boards'],
  // 2768
  ['RBI - PIPE 32 x 3 x 1.5mm', 'pcs', 'Plumbing'],
  // 2769
  ['Dumagsa / Crushed 3/4 (1.4m3)', 'm3', 'Cement & Aggregates'],
  // 2770
  ['Valuesil Brand Silicone - Clear', 'tube', 'Adhesives & Sealants'],
  // 2771
  ['THHN Stranded wire #14', 'rls', 'Electrical'],
  ['THHN Stranded wire #12', 'rls', 'Electrical'],
  // 2772
  ['Mayon Lacquer Thinner (btl) 24btl/ctn', 'ctn', 'Adhesives & Sealants'],
  // 2773
  ['C - purlins 2x3 1.2mm', 'pcs', 'G.I. & Steel'],
  ['Angle Bar 1/8 x 1 2.0mm w/logo', 'pcs', 'G.I. & Steel'],
  // 2774
  ['Mahuhay Portland - Pozzolan - CP7', 'bags', 'Cement & Aggregates'],
  // 2775
  ['Mahuhay Portland - Pozzolan', 'bags', 'Cement & Aggregates'],
  // 2810
  ['Angle Bar 3/16 x 1 w/ logo (2810)', 'pcs', 'G.I. & Steel'],
  ['G.I. Fence tube 1/2 Supreme', 'pcs', 'G.I. & Steel'],
  ['G.I. Fence tube 3/4 Supreme', 'pcs', 'G.I. & Steel'],
  ['G.I. Fence tube 1 1/2 Supreme', 'pcs', 'G.I. & Steel'],
  ['G.I. Wire #16', 'rolls', 'Fasteners'],
  ['Lamberta PE Pipe 1/2 SDR-9', 'rolls', 'Plumbing'],
  ['Ninja Zinc G.I. Plain 24x3x8', 'shts', 'G.I. & Steel'],
  // 2811
  ['rerolled Steel bar 7mm 2-Ok', 'pcs', 'Steel Bars'],
  ['Def-bar 16mm G-33', 'pcs', 'Steel Bars'],
  ['Def. bar 12mm G-33', 'pcs', 'Steel Bars'],
  ['Def. bar 10mm G-33', 'pcs', 'Steel Bars'],
  ['Jea Maxco wall Angle', 'pcs', 'G.I. & Steel'],
  ['Jea Maxco double furring', 'pcs', 'G.I. & Steel'],
  ['Jea Maxco Metal studs 2x3', 'pcs', 'G.I. & Steel'],
  // 2812
  ['G.I. Steel Matting 4x8 4.5mm', 'shts', 'G.I. & Steel'],
  ['Ninja Zinc G.I. Corr. 24x8', 'shts', 'G.I. & Steel'],
  ['Ninja Zinc G.I. Corr. 24x10', 'shts', 'G.I. & Steel'],
  ['Ninja Zinc G.I. Corr. 24x12', 'shts', 'G.I. & Steel'],
  ['Marine Plywood 3/16 4mm (2812)', 'shts', 'Lumber & Boards'],
  ['Marine Plywood 3/4 18mm', 'shts', 'Lumber & Boards'],
  ['Golden Bridge 2.5mm 20kls.', 'cns', 'Fasteners'],
  // 2813
  ['Umbrella Nails 2 1/2', 'kls', 'Fasteners'],
  ['Umbrella Nails 2', 'kls', 'Fasteners'],
  ['Concrete Nails #1', 'ctn', 'Fasteners'],
  ['Concrete Nails #2', 'ctn', 'Fasteners'],
  ['C.W. Nails #3', 'kls', 'Fasteners'],
  ['C.W. Nails #4', 'kls', 'Fasteners'],
  ['Timeout Baby roller ltr-12/1', 'cns', 'Paint & Tools'],
  // 2814
  ['Builder Epoxy Primer Gray ltr-4/1', 'cns', 'Paint'],
  ['Concrete Nails 3', 'kls', 'Fasteners'],
  ['Triton preparakote Gal-4/1', 'cns', 'Paint'],
  ['Triton preparakote ltr 12/1', 'cns', 'Paint'],
  ['Bulldite tile seal White 10/1', 'cns', 'Adhesives & Sealants'],
  ['M/S flat Latex White Gal-4/1', 'cns', 'Paint'],
  ['M/S flat Latex White ltr 12/1', 'cns', 'Paint'],
  // 2815
  ['Metal Tekscrew 2 3500/', 'ctn', 'Fasteners'],
  ['Metal Tekscrew 2 1/2 2500/', 'ctn', 'Fasteners'],
  ['Blind rivets 5/32 x 3/4', 'ctn', 'Fasteners'],
  ['Triton OPE Aluminum Ctn 12/1', 'cns', 'Paint'],
  ['Triton OPE choco-Brown 1/4 ctn 48/1', 'cns', 'Paint'],
  ['Pioneer All purpose Epoxy ltr-6/1', 'cans', 'Adhesives & Sealants'],
  ['Distilled water ctn-30/1', 'pack', 'Miscellaneous'],
  // 2816
  ['Painter blue pipe #1', 'pcs', 'Paint & Tools'],
  ['const-pail #14 H-D', 'pcs', 'Miscellaneous'],
  ['Metal Gypsum Screw #1 10000/', 'ctn', 'Fasteners'],
  ['G.I. elbow 1/2', 'pcs', 'Plumbing'],
  ['Tombo Teflon 1/2', 'pcs', 'Adhesives & Sealants'],
  ['Singer oil', 'pcs', 'Miscellaneous'],
  ['WD-40 6.5oz', 'pcs', 'Miscellaneous'],
  // 2817
  ['WD-40 307', 'pcs', 'Miscellaneous'],
  ['Devcon S-5', 'pcs', 'Adhesives & Sealants'],
  ['Devcon S-520', 'pcs', 'Adhesives & Sealants'],
  ['H/A Baby roller 4', 'pcs', 'Paint & Tools'],
  ['H/A Paint Roller 7', 'pcs', 'Paint & Tools'],
  ['Hitech paint roller 9 (change item)', 'pcs', 'Paint & Tools'],
  ['Lamp cord w/ switch #16', 'pack', 'Electrical'],
  // 2818
  ['Inter plastic Elbow Threaded 1/2', 'pcs', 'Plumbing'],
  ['Dolphin Nylon 0-60mm', 'rolls', 'Fasteners'],
  ['Dolphin Nylon 0-80mm', 'rolls', 'Fasteners'],
  ['Holex Electrode Holder 300A 490230 256', 'pcs', 'Electrical'],
  // 2819
  ['Hitech paint roller 9', 'pcs', 'Paint & Tools'],
  // 2820
  ['h-A Paint Brush 2 1/2', 'pcs', 'Paint & Tools'],
  ['h-A Paint Brush 3', 'pcs', 'Paint & Tools'],
];

// Build a set of existing names to avoid duplicates
const existing = new Set(catalog.map((p) => p.name.toLowerCase()));

let added = 0, skipped = 0;
for (const [name, baseUnit, category] of newItems) {
  const key = name.toLowerCase();
  if (existing.has(key)) { skipped++; continue; }
  existing.add(key);
  catalog.push({
    name,
    category,
    baseUnit,
    stock: 0,
    price: 0,
    units: [{ unit: baseUnit, factor: 1, price: 0 }],
  });
  added++;
}

fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Added ${added} product(s), skipped ${skipped} duplicate(s).  Total: ${catalog.length}.`);