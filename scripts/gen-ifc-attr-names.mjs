// Generates two schema-derived tables into src/parser/ifc-attr-names.generated.ts:
//
//  1. IFC_ATTR_NAMES — UPPERCASE IFC class name → ordered list of explicit
//     attribute names, flattened supertype-first so the array index matches a
//     STEP record's positional argument index. Used by the Tier-2 generic
//     `references` fallback in extractor.ts to label a generic reference edge
//     with the source attribute slot name (ForLayerSet, RelatingStructure, …)
//     instead of the flat "Ref".
//
//  2. IFC_GEOMETRY_TYPES — every concrete class descending from a geometry /
//     representation / placement root. This REPLACES the two
//     hand-maintained name lists that used to live in ifc-loader.ts and
//     geometry-filter.ts. Those lists had diverged from each other (15 names in
//     one, 52 in the other), contained 5 names that do not exist in IFC4X3
//     (IFCI_PROFILEDEF and IFCUPROFILEDEF were typos for IfcIShapeProfileDef /
//     IfcUShapeProfileDef), and between them missed 99 real geometry classes —
//     which then leaked into the graph as nodes. Deriving the set from the
//     schema closes all of those at once and cannot drift again.
//
// Source of truth: dev/referenceDocuments/ifc_classes_with_attrs_and_psetprops.json
// (IFC4X3 schema dump — verified by the presence of IfcRoad / IfcAlignment /
// IfcRelPositions and other 4X3-only classes).
// Regenerate with:  node scripts/gen-ifc-attr-names.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The schema dump is not part of the repo; point IFC_ATTR_SOURCE at it to regenerate.
const SRC = process.env.IFC_ATTR_SOURCE ?? resolve(__dirname, '../dev/referenceDocuments/ifc_classes_with_attrs_and_psetprops.json');
const OUT = resolve(__dirname, '../src/parser/ifc-attr-names.generated.ts');

/**
 * Supertypes whose entire concrete subtree is geometry/representation and
 * therefore never becomes a graph node. Chosen to cover the schema's geometry
 * surface without touching anything semantic — see the assertion at the bottom,
 * which fails the build if a semantic class ever lands here.
 *
 * Styling values (IfcPresentationStyle / IfcPresentationItem /
 * IfcColourSpecification) are deliberately NOT roots: they are attribute-bearing
 * resources an IDS attribute facet must be able to address
 * (IfcSurfaceStyleRendering.DiffuseColour, IfcSurfaceStyleRefraction.RefractionIndex,
 * IfcColourRgb, …), not representation geometry.
 */
const GEOMETRY_ROOTS = [
  'IfcRepresentationItem',          // all curves, surfaces, solids, points, topology
  'IfcProfileDef',                  // cross-section profiles
  'IfcObjectPlacement',             // IfcLocalPlacement / IfcGridPlacement / IfcLinearPlacement
  'IfcRepresentation',              // IfcShapeRepresentation / IfcTopologyRepresentation / …
  'IfcRepresentationContext',       // IfcGeometricRepresentationContext (+ SubContext)
  'IfcProductRepresentation',       // IfcProductDefinitionShape, IfcMaterialDefinitionRepresentation
  'IfcRepresentationMap',           // the mapped-geometry source block
  'IfcOrientedEdge',                // topology; not under IfcRepresentationItem in 4X3
  'IfcPresentationLayerAssignment', // (+ WithStyle)
  'IfcShapeAspect',
  'IfcCartesianPointList',
  'IfcTextureCoordinate',
];

/**
 * Individually-named geometry/styling classes that do NOT sit under any root
 * above. Listed one by one on purpose: each descends from a supertype that is
 * otherwise semantic, so adding that supertype as a root would wrongly discard
 * real nodes (IfcExternallyDefinedSurfaceStyle is an IfcExternalReference — the
 * same supertype as IfcClassificationReference and IfcDocumentReference, which
 * must stay).
 */
const GEOMETRY_EXTRAS = [
  'IfcExternallyDefinedSurfaceStyle',
  'IfcExternallyDefinedHatchStyle',
  'IfcExternallyDefinedTextFont',
];

/**
 * Geometry/styling classes that existed in IFC2X3 (and often IFC4) but were
 * REMOVED from IFC4X3, so the schema dump cannot produce them. They still occur
 * in the wild — real IFC2X3 exports in dev/sampleFiles carry thousands of
 * IfcPresentationStyleAssignment records — and we still parse those files, so
 * the set must cover them explicitly. UPPERCASE, since they are matched against
 * a normalised STEP type name and have no schema entry to derive a name from.
 */
const LEGACY_GEOMETRY_TYPES = [
  'IFCPRESENTATIONSTYLEASSIGNMENT',      // IFC2X3/IFC4; deleted in IFC4X3
  'IFCFILLAREASTYLETILESYMBOLWITHSTYLE', // IFC2X3; deleted in IFC4
  'IFC2DCOMPOSITECURVE',                 // IFC2X3
  'IFCTWODIRECTIONREPEATFACTOR',         // IFC2X3
];

const data = JSON.parse(readFileSync(SRC, 'utf8'));
const classes = data.classes;

/** Root-first inheritance chain for a class name. */
function chain(name) {
  const out = [];
  const seen = new Set();
  let c = name;
  while (c && classes[c] && !seen.has(c)) {
    seen.add(c);
    out.unshift(c);
    c = classes[c].parent;
  }
  return out;
}

/** Flattened explicit attribute names, supertype-first (= STEP arg order). */
function attrNames(name) {
  const names = [];
  for (const c of chain(name)) {
    const ex = classes[c]?.attributes?.explicit || [];
    for (const a of ex) names.push(a.name);
  }
  return names;
}

const out = {};
for (const name of Object.keys(classes)) {
  if (classes[name].kind !== 'IfcClass') continue; // skip enums
  if (name.startsWith('IfcRel')) continue;          // rels have their own predicates
  if (classes[name].isAbstract) continue;           // abstract types never appear as STEP records
  const names = attrNames(name);
  if (names.length === 0) continue;
  out[name.toUpperCase()] = names;
}

// ---------------------------------------------------------------------------
// IFC_GEOMETRY_TYPES — concrete descendants of the geometry roots
// ---------------------------------------------------------------------------

/** True when `name` is `root` or descends from it. */
function descendsFrom(name, root) {
  return chain(name).includes(root);
}

const geometry = new Set();
for (const name of Object.keys(classes)) {
  const c = classes[name];
  if (c.kind !== 'IfcClass') continue;
  if (c.isAbstract) continue; // abstract types never appear as STEP records
  if (GEOMETRY_ROOTS.some(root => descendsFrom(name, root)) || GEOMETRY_EXTRAS.includes(name)) {
    geometry.add(name.toUpperCase());
  }
}

// Guard: a semantic class must never be classified as geometry. If a future
// schema dump reparents something, fail loudly rather than silently deleting
// half the model from the graph.
const SEMANTIC_CANARIES = [
  'IfcWall', 'IfcDoor', 'IfcWindow', 'IfcSlab', 'IfcBeam', 'IfcColumn',
  'IfcSpace', 'IfcBuilding', 'IfcBuildingStorey', 'IfcSite', 'IfcProject',
  'IfcMaterial', 'IfcPropertySet', 'IfcPropertySingleValue', 'IfcElementQuantity',
  'IfcClassification', 'IfcClassificationReference', 'IfcDocumentReference',
  'IfcTask', 'IfcActor', 'IfcRoad', 'IfcBridge', 'IfcAlignment',
  'IfcBuildingElementProxy', 'IfcDistributionPort', 'IfcOpeningElement',
  // Styling values must stay IDS-addressable (attribute facets target them).
  'IfcSurfaceStyleRendering', 'IfcSurfaceStyleRefraction', 'IfcColourRgb',
];
const leaked = SEMANTIC_CANARIES.filter(n => geometry.has(n.toUpperCase()));
if (leaked.length) {
  throw new Error(`GEOMETRY_ROOTS captured semantic classes: ${leaked.join(', ')}`);
}

for (const t of LEGACY_GEOMETRY_TYPES) geometry.add(t);

const geometrySorted = [...geometry].sort();

const banner = `// AUTO-GENERATED by scripts/gen-ifc-attr-names.mjs — do not edit by hand.
// Source: dev/referenceDocuments/ifc_classes_with_attrs_and_psetprops.json (IFC4X3).
// Regenerate: node scripts/gen-ifc-attr-names.mjs\n`;

const body =
  `// UPPERCASE IFC class → ordered explicit attribute names (STEP arg order).\n` +
  `export const IFC_ATTR_NAMES: Record<string, readonly string[]> = ${JSON.stringify(out)};\n\n` +
  `/**\n` +
  ` * Every CONCRETE IFC4X3 class descending from a geometry / representation /\n` +
  ` * placement root — i.e. every class that is discarded at parse time\n` +
  ` * and never becomes a graph node. Derived from the schema, so it cannot drift\n` +
  ` * out of sync with reality the way the previous hand-maintained lists did.\n` +
  ` */\n` +
  `export const IFC_GEOMETRY_TYPES: ReadonlySet<string> = new Set(${JSON.stringify(geometrySorted)});\n`;

writeFileSync(OUT, banner + body);
console.log(
  `Wrote ${OUT}: ${Object.keys(out).length} attr classes, ` +
  `${geometrySorted.length} geometry classes, ${(banner + body).length} bytes`,
);
