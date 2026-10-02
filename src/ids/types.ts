/**
 * IDS (Information Delivery Specification) data model — P5.
 *
 * buildingSMART IDS 1.0. An IDS document is a named set of *specifications*.
 * Each specification has an **applicability** (which entities it applies to)
 * and **requirements** (what those entities must satisfy). Both are expressed
 * as *facets*: Entity, Attribute, Property, Classification, Material, PartOf.
 *
 * The same facet type appears in both applicability and requirements — the
 * difference is intent: in applicability a facet *selects* the entity set; in
 * requirements a facet *asserts* something about each selected entity. In
 * requirements a facet also carries a `cardinality` (required / optional /
 * prohibited).
 *
 * Values in a facet are constrained by an {@link IdsValueRestriction}: a plain
 * value (`simpleValue`), an enumeration, a regex `pattern`, or numeric bounds.
 * These map onto the query engine's operators so the same DuckDB SQL path
 * validates them (ADR-007).
 */

// ---------------------------------------------------------------------------
// Value restrictions (xs:restriction subset used by IDS)
// ---------------------------------------------------------------------------

/**
 * How a facet constrains a value. `undefined` means "any value" (presence only).
 *  - simpleValue — exact match (case-insensitive)
 *  - enumeration — value must be one of the listed strings
 *  - pattern     — value must match this regex (XSD/JS flavour)
 *  - bounds      — numeric range, any subset of min/max with inclusivity
 */
export type IdsValueRestriction =
  | { kind: 'simpleValue'; value: string }
  | { kind: 'enumeration'; values: string[] }
  | { kind: 'pattern'; pattern: string }
  | {
      kind: 'bounds';
      min?: number | undefined;
      max?: number | undefined;
      minInclusive?: boolean | undefined;
      maxInclusive?: boolean | undefined;
    };

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/** IFC entity type (+ optional predefined type), constrained by name. */
export interface EntityFacet {
  kind: 'entity';
  /** IFC class name, e.g. "IFCWALL". Restriction usually a simpleValue/enum. */
  name: IdsValueRestriction;
  /** Optional predefined type constraint. */
  predefinedType?: IdsValueRestriction | undefined;
}

/** A named attribute on the entity (Name, Tag, PredefinedType, …). */
export interface AttributeFacet {
  kind: 'attribute';
  /** The attribute name — restriction, usually simpleValue (e.g. "Name"). */
  name: IdsValueRestriction;
  /** Optional value constraint; undefined = attribute must merely be present. */
  value?: IdsValueRestriction | undefined;
}

/** A property inside a property set. */
export interface PropertyFacet {
  kind: 'property';
  /** Property set name (e.g. "Pset_WallCommon"). */
  propertySet: IdsValueRestriction;
  /** Base (property) name (e.g. "IsExternal"). */
  baseName: IdsValueRestriction;
  /** Optional value constraint on the property value. */
  value?: IdsValueRestriction | undefined;
  /** Optional expected IFC datatype (e.g. "IFCBOOLEAN"); not validated in v1. */
  dataType?: string | undefined;
}

/** A classification reference (system + code). */
export interface ClassificationFacet {
  kind: 'classification';
  /** Classification system name (e.g. "Uniclass 2015"). Optional. */
  system?: IdsValueRestriction | undefined;
  /** The classification code / value. Optional. */
  value?: IdsValueRestriction | undefined;
}

/** A material association. */
export interface MaterialFacet {
  kind: 'material';
  /** Material name constraint. Optional = has any material. */
  value?: IdsValueRestriction | undefined;
}

/**
 * A structural relationship: the entity must be part of / related to another
 * entity (of a given type) via an IFC aggregation/containment relation.
 * IDS `relation` values: IfcRelAggregates, IfcRelContainedInSpatialStructure,
 * IfcRelNests, IfcRelAssignsToGroup, IfcRelVoidsElement, IfcRelFillsElement.
 */
export interface PartOfFacet {
  kind: 'partOf';
  /** The IFC relation type, e.g. "IFCRELAGGREGATES". Empty = any relation. */
  relation: string;
  /** Optional constraint on the related (whole) entity's type. */
  entity?: EntityFacet | undefined;
}

export type IdsFacet =
  | EntityFacet
  | AttributeFacet
  | PropertyFacet
  | ClassificationFacet
  | MaterialFacet
  | PartOfFacet;

// ---------------------------------------------------------------------------
// Requirement wrapper — a facet with a cardinality
// ---------------------------------------------------------------------------

/** IDS requirement cardinality. */
export type Cardinality = 'required' | 'optional' | 'prohibited';

export interface IdsRequirement {
  facet: IdsFacet;
  cardinality: Cardinality;
}

// ---------------------------------------------------------------------------
// Specification + document
// ---------------------------------------------------------------------------

export interface IdsSpecification {
  /** Stable id (generated at parse time — IDS specs have no required id). */
  id: string;
  name: string;
  description?: string | undefined;
  /** IFC schema versions this spec targets, e.g. ["IFC4"]. Informational. */
  ifcVersion?: string[] | undefined;
  /** Applicability facets — an entity must match ALL of them to be in scope. */
  applicability: IdsFacet[];
  /**
   * Specification-level cardinality, from `minOccurs`/`maxOccurs` on the
   * `<applicability>` element. Governs the pass/fail of the *whole spec* by how
   * many entities are applicable (distinct from per-requirement cardinality):
   *   required   (minOccurs≥1) — at least one entity must be applicable; zero → FAIL
   *   optional   (minOccurs=0) — zero applicable is fine (vacuous pass)
   *   prohibited (maxOccurs=0) — no entity may be applicable; any → FAIL
   * Defaults to `required` when unspecified (IDS: applicability minOccurs
   * default is 1).
   */
  cardinality: Cardinality;
  /** Requirements each applicable entity must satisfy. */
  requirements: IdsRequirement[];
}

export interface IdsDocument {
  /** File / title from the IDS `<info><title>`, falling back to filename. */
  title: string;
  description?: string | undefined;
  author?: string | undefined;
  date?: string | undefined;
  specifications: IdsSpecification[];
}

// ---------------------------------------------------------------------------
// Validation results (ephemeral — recomputed on each run)
// ---------------------------------------------------------------------------

/** `${modelId}:${entityId}`. */
export type Uid = string;

/** Why a single entity failed a specification — one entry per failed requirement. */
export interface FailureReason {
  /** Human-readable facet label, e.g. "Property Pset_WallCommon.IsExternal". */
  requirement: string;
  /** What was expected. */
  expected: string;
  /**
   * The entity's actual value for this requirement, when the facet resolves to
   * a single scalar (attribute / property). `null` = the value was missing;
   * `undefined` = the facet has no scalar value to report (entity /
   * classification / material / partOf — a set-membership assertion).
   */
  found?: string | null | undefined;
}

/** One requirement checked on one entity, passed or not. */
export interface RequirementCheck extends FailureReason {
  /** Index into {@link SpecResult.requirements} (and the spec's `requirements`). */
  index: number;
  passed: boolean;
}

/** Per-entity outcome within a specification. */
export interface EntityOutcome {
  uid: Uid;
  ifcType: string;
  name: string | null;
  /** Empty when the entity passed all requirements. */
  failures: FailureReason[];
  /** Every requirement of the specification for this entity, in order (passed ones included). */
  checks: RequirementCheck[];
}

/** Result of validating one specification against all loaded models. */
export interface SpecResult {
  specId: string;
  /** All applicable (in-scope) entities. */
  applicable: Uid[];
  /** Applicable entities that satisfied every requirement. */
  passed: Uid[];
  /** Applicable entities that failed at least one requirement. */
  failed: Uid[];
  /** Per-entity detail, keyed by uid, for the results list. */
  outcomes: Record<Uid, EntityOutcome>;
  /** Requirement labels in the specification's order (the same text as `FailureReason.requirement`). */
  requirements: string[];
  /**
   * Whether the specification's **own cardinality** is satisfied by the number
   * of applicable entities (required→≥1, prohibited→0, optional→always). This is
   * independent of the per-entity requirement pass/fail: a `required` spec with
   * zero applicable entities is `false` here even though `failed` is empty.
   */
  cardinalitySatisfied: boolean;
  /**
   * Human-readable reason when {@link cardinalitySatisfied} is false, e.g.
   * "Required but no applicable entity found in the model." Undefined when
   * satisfied.
   */
  cardinalityReason?: string | undefined;
  durationMs: number;
}
