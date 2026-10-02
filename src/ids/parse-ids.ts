/**
 * IDS 1.0 XML → {@link IdsDocument} via the browser's built-in `DOMParser`
 * (no library — the IDS schema is small and stable). P5.
 *
 * IDS namespace is `http://standards.buildingsmart.org/IDS`. We match elements
 * by local name (ignoring prefix) so a document using any prefix — or the
 * default namespace — parses the same way.
 *
 * Shape (abbreviated):
 *   <ids>
 *     <info><title>…</title><author/><date/></info>
 *     <specifications>
 *       <specification name="…" ifcVersion="IFC4">
 *         <applicability minOccurs="…"> <entity>… facets …</applicability>
 *         <requirements> <property …/> <attribute …/> … </requirements>
 *       </specification>
 *     </specifications>
 *   </ids>
 *
 * Each facet holds one or more of: <name>, <predefinedType>, <propertySet>,
 * <baseName>, <value>, <system>, <relation>, <entity> — each an
 * {@link IdsValueRestriction} carrying a <simpleValue> or an <xs:restriction>.
 */

import type {
  IdsDocument,
  IdsSpecification,
  IdsFacet,
  IdsRequirement,
  IdsValueRestriction,
  Cardinality,
  EntityFacet,
  PartOfFacet,
} from './types.js';

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/** Parse IDS XML text. `fallbackTitle` (usually the filename) is used when the
 * document has no `<info><title>`. Throws on non-IDS / malformed XML. */
export function parseIds(xml: string, fallbackTitle = 'IDS'): IdsDocument {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error(`IDS XML parse error: ${parseError.textContent ?? 'unknown'}`);

  const root = doc.documentElement;
  if (!root || local(root) !== 'ids') {
    throw new Error(`Not an IDS document (root element is <${root ? local(root) : 'empty'}>)`);
  }

  const info = child(root, 'info');
  const title = (info && text(child(info, 'title'))) || fallbackTitle;
  const description = info ? text(child(info, 'description')) : undefined;
  const author = info ? text(child(info, 'author')) : undefined;
  const date = info ? text(child(info, 'date')) : undefined;

  const specsEl = child(root, 'specifications');
  const specEls = specsEl ? children(specsEl, 'specification') : [];
  const specifications = specEls.map((el, i) => parseSpecification(el, i));

  return {
    title,
    description: description || undefined,
    author: author || undefined,
    date: date || undefined,
    specifications,
  };
}

// ---------------------------------------------------------------------------
// Specification
// ---------------------------------------------------------------------------

function parseSpecification(el: Element, index: number): IdsSpecification {
  const name = el.getAttribute('name') ?? `Specification ${index + 1}`;
  const description = el.getAttribute('description') ?? undefined;
  const ifcVersionAttr = el.getAttribute('ifcVersion');
  const ifcVersion = ifcVersionAttr ? ifcVersionAttr.split(/\s+/).filter(Boolean) : undefined;

  const applEl = child(el, 'applicability');
  const applicability = applEl ? parseFacetList(applEl) : [];
  // Specification-level cardinality lives on <applicability minOccurs/maxOccurs>.
  // Default is `required` (IDS applicability minOccurs defaults to 1) so a spec
  // with no cardinality attributes still demands ≥1 applicable entity.
  const cardinality = applEl ? cardinalityOf(applEl) : 'required';

  const reqEl = child(el, 'requirements');
  const requirements: IdsRequirement[] = reqEl
    ? parseFacetElements(reqEl).map((fe) => ({
        facet: parseFacet(fe),
        cardinality: cardinalityOf(fe),
      }))
    : [];

  return {
    id: `spec-${index}`,
    name,
    description,
    ifcVersion,
    applicability,
    cardinality,
    requirements,
  };
}

/** All facet child elements of an applicability/requirements block, in order. */
function parseFacetElements(container: Element): Element[] {
  const facetNames = new Set([
    'entity', 'attribute', 'property', 'classification', 'material', 'partof',
  ]);
  return Array.from(container.children).filter((c) => facetNames.has(local(c)));
}

function parseFacetList(container: Element): IdsFacet[] {
  return parseFacetElements(container).map(parseFacet);
}

/**
 * Requirement cardinality. IDS 1.0 authoring tools emit the explicit
 * `cardinality="required|optional|prohibited"` attribute on the facet element;
 * older/alternate documents express the same intent via `minOccurs`/`maxOccurs`:
 *   cardinality="…"    → used directly when present
 *   maxOccurs="0"      → prohibited
 *   minOccurs="0"      → optional
 *   otherwise          → required
 */
function cardinalityOf(el: Element): Cardinality {
  const explicit = el.getAttribute('cardinality')?.toLowerCase();
  if (explicit === 'required' || explicit === 'optional' || explicit === 'prohibited') {
    return explicit;
  }
  const min = el.getAttribute('minOccurs');
  const max = el.getAttribute('maxOccurs');
  if (max === '0') return 'prohibited';
  if (min === '0') return 'optional';
  return 'required';
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

function parseFacet(el: Element): IdsFacet {
  switch (local(el)) {
    case 'entity':
      return parseEntityFacet(el);
    case 'attribute':
      return {
        kind: 'attribute',
        name: restriction(child(el, 'name')) ?? { kind: 'simpleValue', value: '' },
        value: restriction(child(el, 'value')),
      };
    case 'property':
      return {
        kind: 'property',
        propertySet: restriction(child(el, 'propertySet')) ?? { kind: 'simpleValue', value: '' },
        baseName: restriction(child(el, 'baseName')) ?? { kind: 'simpleValue', value: '' },
        value: restriction(child(el, 'value')),
        dataType: el.getAttribute('dataType') ?? undefined,
      };
    case 'classification':
      return {
        kind: 'classification',
        system: restriction(child(el, 'system')),
        value: restriction(child(el, 'value')),
      };
    case 'material':
      return {
        kind: 'material',
        value: restriction(child(el, 'value')),
      };
    case 'partof':
      return parsePartOfFacet(el);
    default:
      // Unknown facet — degrade to an attribute presence check that never matches.
      return { kind: 'attribute', name: { kind: 'simpleValue', value: '' } };
  }
}

function parseEntityFacet(el: Element): EntityFacet {
  return {
    kind: 'entity',
    name: restriction(child(el, 'name')) ?? { kind: 'simpleValue', value: '' },
    predefinedType: restriction(child(el, 'predefinedType')),
  };
}

function parsePartOfFacet(el: Element): PartOfFacet {
  // `relation` is an attribute in IDS 1.0 (e.g. relation="IfcRelAggregates").
  const relation = (el.getAttribute('relation') ?? '').toUpperCase();
  const entityEl = child(el, 'entity');
  return {
    kind: 'partOf',
    relation,
    entity: entityEl ? parseEntityFacet(entityEl) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Value restriction (<simpleValue> | <xs:restriction>)
// ---------------------------------------------------------------------------

/**
 * Parse an IDS value holder element (e.g. `<name>`, `<value>`, `<system>`) into
 * a restriction. Returns undefined when the element is absent or empty.
 */
export function restriction(el: Element | null): IdsValueRestriction | undefined {
  if (!el) return undefined;

  // Simple case: <simpleValue>text</simpleValue>
  const simple = child(el, 'simpleValue');
  if (simple) {
    const v = text(simple);
    return v ? { kind: 'simpleValue', value: v } : undefined;
  }

  // Bare text (some tools put the value directly): <name>IFCWALL</name>
  const direct = directText(el);
  if (direct && el.children.length === 0) {
    return { kind: 'simpleValue', value: direct };
  }

  // <xs:restriction base="xs:string"> with facets.
  const restr = child(el, 'restriction');
  if (restr) return parseXsRestriction(restr);

  return undefined;
}

function parseXsRestriction(restr: Element): IdsValueRestriction | undefined {
  // Enumeration: multiple <xs:enumeration value="…"/>
  const enums = children(restr, 'enumeration')
    .map((e) => e.getAttribute('value'))
    .filter((v): v is string => v != null);
  if (enums.length > 0) return { kind: 'enumeration', values: enums };

  // Pattern: <xs:pattern value="…"/>
  const pat = child(restr, 'pattern')?.getAttribute('value');
  if (pat) return { kind: 'pattern', pattern: pat };

  // Numeric bounds via min/maxInclusive / min/maxExclusive.
  const minInc = numAttr(child(restr, 'mininclusive'));
  const minExc = numAttr(child(restr, 'minexclusive'));
  const maxInc = numAttr(child(restr, 'maxinclusive'));
  const maxExc = numAttr(child(restr, 'maxexclusive'));
  if (minInc != null || minExc != null || maxInc != null || maxExc != null) {
    return {
      kind: 'bounds',
      min: minInc ?? minExc,
      max: maxInc ?? maxExc,
      minInclusive: minInc != null,
      maxInclusive: maxInc != null,
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// DOM helpers — local-name based, namespace-agnostic
// ---------------------------------------------------------------------------

/** Lowercased local name (strips any namespace prefix). */
function local(el: Element): string {
  return (el.localName || el.nodeName.replace(/^.*:/, '')).toLowerCase();
}

/** First direct child element with the given local name (case-insensitive). */
function child(parent: Element | null, name: string): Element | null {
  if (!parent) return null;
  const lc = name.toLowerCase();
  for (const c of Array.from(parent.children)) {
    if (local(c) === lc) return c;
  }
  return null;
}

/** All direct child elements with the given local name (case-insensitive). */
function children(parent: Element, name: string): Element[] {
  const lc = name.toLowerCase();
  return Array.from(parent.children).filter((c) => local(c) === lc);
}

/** Trimmed text content of an element (or '' when null). */
function text(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

/** Direct (non-descendant) text of an element, trimmed. */
function directText(el: Element): string {
  let s = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3 /* text */) s += n.textContent ?? '';
  }
  return s.trim();
}

function numAttr(el: Element | null): number | undefined {
  if (!el) return undefined;
  const v = el.getAttribute('value');
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
