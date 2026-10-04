import type { Triple, ParsedModel, EntityIndex, IfcEntity } from './types.js';
import type { RawRecord } from './tokenizer.js';
import { splitArgs, refId, listRefs, recordToEntity } from './tokenizer.js';
import { isGeometry, isPlacementType } from './geometry-filter.js';
import { IFC_ATTR_NAMES } from './ifc-attr-names.generated.js';
import type { BimUseProfileId } from './bim-use-filter.js';
import { filterTriples } from './bim-use-filter.js';
import { IfcLoader } from './ifc-loader.js';
import type { GeomStats } from './ifc-loader.js';
import { resolveUnits, resolveValueUnit, resolvePropertyValueUnit, type UnitTable } from './units.js';

const QTY_TYPES = new Set([
  'IFCQUANTITYLENGTH', 'IFCQUANTITYAREA', 'IFCQUANTITYVOLUME',
  'IFCQUANTITYCOUNT', 'IFCQUANTITYWEIGHT', 'IFCQUANTITYTIME',
  'IFCQUANTITYNUMBER',
]);

/**
 * Attach the resolved unit label + SI-normalized value to a property/quantity
 * entity (PB-B). The raw decoded value already lives on `propValue`/`qtyValue`;
 * here we resolve the authored unit (explicit ref or project default) and
 * compute the SI base-unit equivalent.
 *
 * Stored values keep **full precision** — rounding is a display concern, applied
 * by the UI (see `formatQtyValue` in the properties panel), not baked into the
 * parsed model or the DuckDB store.
 */
function enrichValueUnit(entity: IfcEntity, rec: RawRecord, units: UnitTable): void {
  const isProp = entity.propValue != null || (entity.propValues?.length ?? 0) > 0;
  const isQty = QTY_TYPES.has(rec.type) && entity.qtyValue != null;
  if (!isProp && !isQty) return;

  const resolved = resolveValueUnit(rec.type, rec.line, units);
  const rawValue = isQty ? entity.qtyValue : entity.propValue;
  const num = rawValue != null ? Number(rawValue) : NaN;
  const si = Number.isFinite(num) && resolved ? num * resolved.siFactor : null;

  if (isQty) {
    if (resolved) entity.qtyUnit = resolved.label;
    if (si !== null) entity.qtyValueSi = si;
  } else {
    if (resolved) entity.propUnit = resolved.label;
    if (si !== null) entity.propValueSi = si;
  }

  // Multi-valued properties (enumerated / list / bounded / table) keep every
  // authored value: normalize each one, so the IDS property facet can test each
  // value against an SI IDS value (property-facet.md). The unit comes from the
  // value's own unit slot, else the project default for its measure dimension.
  for (const v of entity.propValues ?? []) {
    const unit = resolvePropertyValueUnit(v.unitRef, v.measure, units);
    const n = Number(v.value);
    v.unit = unit?.label ?? null;
    v.si = Number.isFinite(n) ? n * (unit?.siFactor ?? 1) : null;
  }
}

// ---------------------------------------------------------------------------
// IfcRel* triple extraction rules
// Argument indices are 0-based after the outer parens are stripped.
// Standard IfcRoot attrs: [0]=GlobalId [1]=OwnerHistory [2]=Name [3]=Description
// Relationship-specific attrs start at [4].
// ---------------------------------------------------------------------------

type RelHandler = (relId: number, args: string[]) => Triple[];

/** Safe arg accessor: returns '' when index is out of bounds (noUncheckedIndexedAccess) */
const a = (args: string[], i: number): string => args[i] ?? '';

const REL_HANDLERS: Record<string, RelHandler> = {
  IFCRELAGGREGATES(_relId, args) {
    // args[4]=RelatingObject (parent), args[5]=(RelatedObjects list)
    const parent = refId(a(args, 4));
    if (parent === null) return [];
    return listRefs(a(args, 5)).map(child => ({
      subject: parent,
      predicate: 'IfcRelAggregates',
      object: child,
    }));
  },

  IFCRELCONTAINEDINSPATIALSTRUCTURE(_relId, args) {
    // args[4]=(RelatedElements list), args[5]=RelatingStructure (container)
    const container = refId(a(args, 5));
    if (container === null) return [];
    return listRefs(a(args, 4)).map(el => ({
      subject: container,
      predicate: 'IfcRelContainedInSpatialStructure',
      object: el,
    }));
  },

  IFCRELDEFINESBYPROPERTIES(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatingPropertyDefinition (pset/qset)
    const pset = refId(a(args, 5));
    if (pset === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: obj,
      predicate: 'IfcRelDefinesByProperties',
      object: pset,
    }));
  },

  IFCRELDEFINESBYTYPE(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatingType
    const type = refId(a(args, 5));
    if (type === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: type,
      predicate: 'IfcRelDefinesByType',
      object: obj,
    }));
  },

  IFCRELVOIDSELEMENT(_relId, args) {
    // args[4]=RelatingBuildingElement (host), args[5]=RelatedOpeningElement
    const host = refId(a(args, 4));
    const opening = refId(a(args, 5));
    if (host === null || opening === null) return [];
    return [{ subject: host, predicate: 'IfcRelVoidsElement', object: opening }];
  },

  IFCRELFILLSELEMENT(_relId, args) {
    // args[4]=RelatingOpeningElement, args[5]=RelatedBuildingElement
    const opening = refId(a(args, 4));
    const filling = refId(a(args, 5));
    if (opening === null || filling === null) return [];
    return [{ subject: opening, predicate: 'IfcRelFillsElement', object: filling }];
  },

  IFCRELCONNECTSELEMENTS(_relId, args) {
    // IfcRelConnectsElements declares ConnectionGeometry FIRST:
    // args[4]=ConnectionGeometry, args[5]=RelatingElement, args[6]=RelatedElement
    const src = refId(a(args, 5));
    const tgt = refId(a(args, 6));
    if (src === null || tgt === null) return [];
    return [{ subject: src, predicate: 'IfcRelConnectsElements', object: tgt }];
  },

  IFCRELCONNECTSPATHELEMENTS(_relId, args) {
    // Subtype of IfcRelConnectsElements — same [4]=ConnectionGeometry offset.
    const src = refId(a(args, 5));
    const tgt = refId(a(args, 6));
    if (src === null || tgt === null) return [];
    return [{ subject: src, predicate: 'IfcRelConnectsPathElements', object: tgt }];
  },

  IFCRELASSOCIATESCLASSIFICATION(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatingClassification
    const classif = refId(a(args, 5));
    if (classif === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: obj,
      predicate: 'IfcRelAssociatesClassification',
      object: classif,
    }));
  },

  IFCEXTERNALREFERENCERELATIONSHIP(_relId, args) {
    // IFC4 resource-level relationship (no GlobalId): args[0]=Name, args[1]=Description,
    // args[2]=RelatingReference, args[3]=(RelatedResourceObjects). How resources that are not
    // IfcRoot (e.g. IfcMaterial) carry a classification reference; emitted as the same edge as
    // IfcRelAssociatesClassification so the classifications view treats both alike.
    const ref = refId(a(args, 2));
    if (ref === null) return [];
    return listRefs(a(args, 3)).map(obj => ({
      subject: obj,
      predicate: 'IfcRelAssociatesClassification',
      object: ref,
    }));
  },

  IFCRELASSOCIATESDOCUMENT(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatingDocument
    const doc = refId(a(args, 5));
    if (doc === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: obj,
      predicate: 'IfcRelAssociatesDocument',
      object: doc,
    }));
  },

  IFCRELASSOCIATESMATERIAL(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatingMaterial
    const mat = refId(a(args, 5));
    if (mat === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: obj,
      predicate: 'IfcRelAssociatesMaterial',
      object: mat,
    }));
  },

  IFCRELASSIGNSTOGROUP(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatedObjectsType (enum, skip), args[6]=RelatingGroup
    const group = refId(a(args, 6));
    if (group === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: group,
      predicate: 'IfcRelAssignsToGroup',
      object: obj,
    }));
  },

  IFCRELSPACEBOUNDARY(_relId, args) {
    // args[4]=RelatingSpace, args[5]=RelatedBuildingElement
    const space = refId(a(args, 4));
    const el = refId(a(args, 5));
    if (space === null || el === null) return [];
    return [{ subject: space, predicate: 'IfcRelSpaceBoundary', object: el }];
  },

  IFCRELSPACEBOUNDARY1STLEVEL(_relId, args) {
    const space = refId(a(args, 4));
    const el = refId(a(args, 5));
    if (space === null || el === null) return [];
    return [{ subject: space, predicate: 'IfcRelSpaceBoundary', object: el }];
  },

  IFCRELSPACEBOUNDARY2NDLEVEL(_relId, args) {
    const space = refId(a(args, 4));
    const el = refId(a(args, 5));
    if (space === null || el === null) return [];
    return [{ subject: space, predicate: 'IfcRelSpaceBoundary', object: el }];
  },

  IFCRELNESTS(_relId, args) {
    // args[4]=RelatingObject, args[5]=(RelatedObjects)
    const parent = refId(a(args, 4));
    if (parent === null) return [];
    return listRefs(a(args, 5)).map(child => ({
      subject: parent,
      predicate: 'IfcRelNests',
      object: child,
    }));
  },

  IFCRELDECLARES(_relId, args) {
    const ctx = refId(a(args, 4));
    if (ctx === null) return [];
    return listRefs(a(args, 5)).map(def => ({
      subject: ctx,
      predicate: 'IfcRelDeclares',
      object: def,
    }));
  },

  IFCRELDEFINESBYOBJECT(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatingObject
    const relating = refId(a(args, 5));
    if (relating === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: relating,
      predicate: 'IfcRelDefinesByObject',
      object: obj,
    }));
  },

  IFCRELDEFINESBYTEMPLATE(_relId, args) {
    // args[4]=(RelatedPropertySets), args[5]=RelatingTemplate
    const template = refId(a(args, 5));
    if (template === null) return [];
    return listRefs(a(args, 4)).map(pset => ({
      subject: template,
      predicate: 'IfcRelDefinesByTemplate',
      object: pset,
    }));
  },

  IFCRELASSIGNSTOACTOR(_relId, args) {
    // args[4]=(RelatedObjects), args[6]=RelatingActor
    const actor = refId(a(args, 6));
    if (actor === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: actor,
      predicate: 'IfcRelAssignsToActor',
      object: obj,
    }));
  },

  IFCRELASSIGNSTOCONTROL(_relId, args) {
    // args[4]=(RelatedObjects), args[6]=RelatingControl
    const control = refId(a(args, 6));
    if (control === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: control,
      predicate: 'IfcRelAssignsToControl',
      object: obj,
    }));
  },

  IFCRELASSIGNSTOGROUPBYFACTOR(_relId, args) {
    // args[4]=(RelatedObjects), args[6]=RelatingGroup
    const group = refId(a(args, 6));
    if (group === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: group,
      predicate: 'IfcRelAssignsToGroup',
      object: obj,
    }));
  },

  IFCRELASSIGNSTOPROCESS(_relId, args) {
    // args[4]=(RelatedObjects), args[6]=RelatingProcess
    const process = refId(a(args, 6));
    if (process === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: process,
      predicate: 'IfcRelAssignsToProcess',
      object: obj,
    }));
  },

  IFCRELASSIGNSTOPRODUCT(_relId, args) {
    // args[4]=(RelatedObjects), args[6]=RelatingProduct
    const product = refId(a(args, 6));
    if (product === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: product,
      predicate: 'IfcRelAssignsToProduct',
      object: obj,
    }));
  },

  IFCRELASSIGNSTORESOURCE(_relId, args) {
    // args[4]=(RelatedObjects), args[6]=RelatingResource
    const resource = refId(a(args, 6));
    if (resource === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: resource,
      predicate: 'IfcRelAssignsToResource',
      object: obj,
    }));
  },

  IFCRELASSOCIATESAPPROVAL(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatingApproval
    const approval = refId(a(args, 5));
    if (approval === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: obj,
      predicate: 'IfcRelAssociatesApproval',
      object: approval,
    }));
  },

  IFCRELASSOCIATESCONSTRAINT(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=Intent, args[6]=RelatingConstraint.
    // Unlike its IfcRelAssociates* siblings (Library/Document/Approval, whose
    // relating ref is at [5]), this class declares an extra `Intent` attribute
    // first — so [6] is correct here.
    const constraint = refId(a(args, 6));
    if (constraint === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: obj,
      predicate: 'IfcRelAssociatesConstraint',
      object: constraint,
    }));
  },

  IFCRELASSOCIATESLIBRARY(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatingLibrary
    const lib = refId(a(args, 5));
    if (lib === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: obj,
      predicate: 'IfcRelAssociatesLibrary',
      object: lib,
    }));
  },

  IFCRELASSOCIATESPROFILEDEF(_relId, args) {
    // args[4]=(RelatedObjects), args[5]=RelatingProfileDef
    const profile = refId(a(args, 5));
    if (profile === null) return [];
    return listRefs(a(args, 4)).map(obj => ({
      subject: obj,
      predicate: 'IfcRelAssociatesProfileDef',
      object: profile,
    }));
  },

  IFCRELADHERESTOELEMENT(_relId, args) {
    // args[4]=RelatingElement, args[5]=(RelatedSurfaceFeatures)
    const el = refId(a(args, 4));
    if (el === null) return [];
    return listRefs(a(args, 5)).map(feat => ({
      subject: el,
      predicate: 'IfcRelAdheresToElement',
      object: feat,
    }));
  },

  IFCRELCOVERSBLDGELEMENTS(_relId, args) {
    // args[4]=RelatingBuildingElement, args[5]=(RelatedCoverings)
    const el = refId(a(args, 4));
    if (el === null) return [];
    return listRefs(a(args, 5)).map(cov => ({
      subject: el,
      predicate: 'IfcRelCoversBldgElements',
      object: cov,
    }));
  },

  IFCRELCOVERSSPACES(_relId, args) {
    // args[4]=RelatingSpace, args[5]=(RelatedCoverings)
    const space = refId(a(args, 4));
    if (space === null) return [];
    return listRefs(a(args, 5)).map(cov => ({
      subject: space,
      predicate: 'IfcRelCoversSpaces',
      object: cov,
    }));
  },

  IFCRELPROJECTSELEMENT(_relId, args) {
    // args[4]=RelatingElement, args[5]=RelatedFeatureElement
    const el = refId(a(args, 4));
    const feat = refId(a(args, 5));
    if (el === null || feat === null) return [];
    return [{ subject: el, predicate: 'IfcRelProjectsElement', object: feat }];
  },

  IFCRELCONNECTSPORTTOELEMENT(_relId, args) {
    // args[4]=RelatingPort, args[5]=RelatedElement
    const port = refId(a(args, 4));
    const el = refId(a(args, 5));
    if (port === null || el === null) return [];
    return [{ subject: port, predicate: 'IfcRelConnectsPortToElement', object: el }];
  },

  IFCRELCONNECTSPORTS(_relId, args) {
    // args[4]=RelatingPort, args[5]=RelatedPort
    const src = refId(a(args, 4));
    const tgt = refId(a(args, 5));
    if (src === null || tgt === null) return [];
    return [{ subject: src, predicate: 'IfcRelConnectsPorts', object: tgt }];
  },

  IFCRELCONNECTSSTRUCTURALACTIVITY(_relId, args) {
    // args[4]=RelatingElement, args[5]=RelatedStructuralActivity
    const el = refId(a(args, 4));
    const activity = refId(a(args, 5));
    if (el === null || activity === null) return [];
    return [{ subject: el, predicate: 'IfcRelConnectsStructuralActivity', object: activity }];
  },

  IFCRELCONNECTSSTRUCTURALMEMBER(_relId, args) {
    // args[4]=RelatingStructuralMember, args[5]=RelatedStructuralConnection
    const member = refId(a(args, 4));
    const conn = refId(a(args, 5));
    if (member === null || conn === null) return [];
    return [{ subject: member, predicate: 'IfcRelConnectsStructuralMember', object: conn }];
  },

  IFCRELCONNECTSWITHECCENTRICITY(_relId, args) {
    // Subtype of IfcRelConnectsStructuralMember — inherits its arg layout:
    // args[4]=RelatingStructuralMember, args[5]=RelatedStructuralConnection.
    // Collapsed onto the supertype predicate; the eccentricity itself
    // (ConnectionConstraint, arg[10]) is geometry and is not retained.
    const member = refId(a(args, 4));
    const conn = refId(a(args, 5));
    if (member === null || conn === null) return [];
    return [{ subject: member, predicate: 'IfcRelConnectsStructuralMember', object: conn }];
  },

  IFCRELCONNECTSWITHREALIZINGELEMENTS(_relId, args) {
    // Subtype of IfcRelConnectsElements — same [4]=ConnectionGeometry offset:
    // args[5]=RelatingElement, args[6]=RelatedElement.
    const src = refId(a(args, 5));
    const tgt = refId(a(args, 6));
    if (src === null || tgt === null) return [];
    return [{ subject: src, predicate: 'IfcRelConnectsElements', object: tgt }];
  },

  IFCRELINTERFERESELEMENTS(_relId, args) {
    const src = refId(a(args, 4));
    const tgt = refId(a(args, 5));
    if (src === null || tgt === null) return [];
    return [{ subject: src, predicate: 'IfcRelInterferesElements', object: tgt }];
  },

  IFCRELFLOWCONTROLELEMENTS(_relId, args) {
    // args[4]=(RelatedControlElements), args[5]=RelatingFlowElement
    const flow = refId(a(args, 5));
    if (flow === null) return [];
    return listRefs(a(args, 4)).map(ctrl => ({
      subject: flow,
      predicate: 'IfcRelFlowControlElements',
      object: ctrl,
    }));
  },

  IFCRELSEQUENCE(_relId, args) {
    // args[4]=RelatingProcess, args[5]=RelatedProcess
    const src = refId(a(args, 4));
    const tgt = refId(a(args, 5));
    if (src === null || tgt === null) return [];
    return [{ subject: src, predicate: 'IfcRelSequence', object: tgt }];
  },

  IFCRELSERVICESBUILDINGS(_relId, args) {
    // args[4]=RelatingSystem, args[5]=(RelatedBuildings)
    const system = refId(a(args, 4));
    if (system === null) return [];
    return listRefs(a(args, 5)).map(bldg => ({
      subject: system,
      predicate: 'IfcRelServicesBuildings',
      object: bldg,
    }));
  },

  IFCRELREFERENCEDINSPATIALSTRUCTURE(_relId, args) {
    const container = refId(a(args, 5));
    if (container === null) return [];
    return listRefs(a(args, 4)).map(el => ({
      subject: container,
      predicate: 'IfcRelReferencedInSpatialStructure',
      object: el,
    }));
  },

  IFCRELPOSITIONS(_relId, args) {
    // args[4]=RelatingPositioningElement, args[5]=(RelatedProducts)
    const posEl = refId(a(args, 4));
    if (posEl === null) return [];
    return listRefs(a(args, 5)).map(prod => ({
      subject: posEl,
      predicate: 'IfcRelPositions',
      object: prod,
    }));
  },
};

// ---------------------------------------------------------------------------
// Synthetic triples: non-Rel entities that embed sub-entity refs in their args
// These create structural edges without an IfcRel* entity as intermediary.
// Format: type → [{ argIndex, predicate, isList }]
// ---------------------------------------------------------------------------

type SyntheticRule = { argIndex: number; predicate: string; isList: boolean };

const SYNTHETIC_RULES: Record<string, SyntheticRule[]> = {
  // Material composition — set → member
  IFCMATERIALCONSTITUENTSET: [{ argIndex: 2, predicate: 'hasMaterialConstituent', isList: true }],
  IFCMATERIALLAYERSET:       [{ argIndex: 0, predicate: 'hasMaterialLayer',       isList: true }],
  IFCMATERIALPROFILESET:     [{ argIndex: 2, predicate: 'hasMaterialProfile',     isList: true }],
  IFCMATERIALLIST:           [{ argIndex: 0, predicate: 'hasMaterial',            isList: true }],
  // Material composition — member → IfcMaterial leaf
  IFCMATERIALCONSTITUENT:    [{ argIndex: 2, predicate: 'hasMaterial', isList: false }],
  IFCMATERIALLAYER:          [{ argIndex: 0, predicate: 'hasMaterial', isList: false }],
  IFCMATERIALPROFILE:        [{ argIndex: 2, predicate: 'hasMaterial', isList: false }],
  // With-offsets subtypes inherit the same member → IfcMaterial leaf attribute
  IFCMATERIALLAYERWITHOFFSETS:   [{ argIndex: 0, predicate: 'hasMaterial', isList: false }],
  IFCMATERIALPROFILEWITHOFFSETS: [{ argIndex: 2, predicate: 'hasMaterial', isList: false }],
  // Material usage → the shared set it references (ForLayerSet / ForProfileSet, arg[0]).
  // Without these, a usage node reached via IfcRelAssociatesMaterial is a dead-end —
  // it never steps through to its IfcMaterialLayerSet / IfcMaterialProfileSet.
  IFCMATERIALLAYERSETUSAGE:   [{ argIndex: 0, predicate: 'hasMaterialLayerSet',   isList: false }],
  IFCMATERIALPROFILESETUSAGE: [{ argIndex: 0, predicate: 'hasMaterialProfileSet', isList: false }],

  // Material → classification reference. This is what carries an external
  // environmental-dataset identifier (e.g. an OEKOBAUDAT UUID, in the
  // reference's Identification) down at the *material* level, where an
  // IfcMaterial — not being an IfcRoot subtype — has no GlobalId of its own.
  //
  // Two spellings, because the schema changed and both appear in the wild:
  //
  //  - IFCMATERIALCLASSIFICATIONRELATIONSHIP (IFC2x3; deprecated since IFC4)
  //    args: [MaterialClassifications (SET), ClassifiedMaterial]. The rule
  //    emits relationship → each classification. The relationship node reaches
  //    its material through arg[1] via the generic `references` fallback.
  //
  //  - IFCEXTERNALREFERENCERELATIONSHIP (IFC4+ replacement)
  //    args: [Name, Description, RelatingReference, RelatedResourceObjects].
  //    Direction is *reversed*: the reference is the single relating arg and
  //    the materials are the list. So the edge emitted here is
  //    relationship → each related resource object, and arg[2] (the reference)
  //    is picked up the same way. The `materials` view joins through whichever
  //    of the two shapes is present rather than assuming one.
  IFCMATERIALCLASSIFICATIONRELATIONSHIP: [
    { argIndex: 0, predicate: 'hasMaterialClassification', isList: true },
  ],
  IFCEXTERNALREFERENCERELATIONSHIP: [
    { argIndex: 2, predicate: 'hasMaterialClassification', isList: false },
  ],

  // Property sets / quantities
  IFCPROPERTYSET:           [{ argIndex: 4, predicate: 'hasProperty',   isList: true }],
  IFCELEMENTQUANTITY:       [{ argIndex: 5, predicate: 'hasQuantity',   isList: true }],
  IFCPROPERTYSETSTEMPLATE:  [{ argIndex: 6, predicate: 'hasTemplate',   isList: true }],
  IFCCOMPLEXPROPERTY:       [{ argIndex: 3, predicate: 'hasProperty',   isList: true }],

  // Approval / constraint chains
  IFCAPPROVALRELATIONSHIP:  [
    { argIndex: 2, predicate: 'relatedApproval',  isList: false },
    { argIndex: 3, predicate: 'relatingApproval', isList: false },
  ],

  // Approval / constraint chains (end of section)
};

function buildSyntheticTriples(
  records: RawRecord[],
  entities: EntityIndex,
  triples: Triple[],
): void {
  for (const rec of records) {
    const rules = SYNTHETIC_RULES[rec.type];
    if (!rules) continue;
    if (!entities.has(rec.id)) continue;
    const args = splitArgs(rec.args);
    for (const rule of rules) {
      const raw = args[rule.argIndex] ?? '';
      const targets = rule.isList ? listRefs(raw) : (refId(raw) !== null ? [refId(raw)!] : []);
      for (const tgt of targets) {
        if (entities.has(tgt)) {
          triples.push({ subject: rec.id, predicate: rule.predicate, object: tgt });
        }
      }
    }
  }

  for (const rec of records) {
    if (rec.type !== 'IFCCLASSIFICATIONREFERENCE') continue;
    if (!entities.has(rec.id)) continue;
    const args = splitArgs(rec.args);
    const parentId = refId(args[3] ?? '');
    if (parentId !== null && entities.has(parentId)) {
      triples.push({ subject: parentId, predicate: 'hasClassificationReference', object: rec.id });
    }
  }

  // IfcTypeObject.HasPropertySets — arg[5] is a list of property-set refs on every
  // IFC*TYPE / IFC*STYLE entity. There is no IfcRel* intermediary for type psets,
  // so emit a synthetic 'hasPropertySet' edge (distinct from occurrence
  // 'IfcRelDefinesByProperties'). The properties panel reads this for the Type section.
  for (const rec of records) {
    if (!isTypeObject(rec.type)) continue;
    if (!entities.has(rec.id)) continue;
    const args = splitArgs(rec.args);
    for (const psetId of listRefs(args[5] ?? '')) {
      if (entities.has(psetId)) {
        triples.push({ subject: rec.id, predicate: 'hasPropertySet', object: psetId });
      }
    }
  }
}

/**
 * True for IfcTypeObject subtypes (IFC*TYPE) and the legacy IfcDoorStyle /
 * IfcWindowStyle, all of which carry HasPropertySets at arg[5].
 * IFCRELDEFINESBYTYPE is excluded — it is a relationship, not a type object.
 */
function isTypeObject(type: string): boolean {
  if (type.startsWith('IFCREL')) return false;
  return type.endsWith('TYPE') || type === 'IFCDOORSTYLE' || type === 'IFCWINDOWSTYLE';
}

/**
 * Generic reference fallback (Tier 2). Catches structural links that no named
 * REL_HANDLER or SYNTHETIC_RULES entry covers, so a kept entity can never be a
 * traversal dead-end merely because its outgoing attribute wasn't hand-mapped.
 *
 * For every kept, non-IfcRel record, scan ALL its args for `#id` references; for
 * each token pointing at another KEPT entity that is NOT already linked (in
 * either direction) by an existing triple, emit a single generic `references`
 * edge. This cannot explode the graph: geometry, placements and property values
 * are already absent from `entities`, so `entities.has(tgt)` gates them out, and
 * the pair-dedupe skips anything a semantic rule already produced.
 *
 * Runs LAST — after buildSyntheticTriples and the REL_HANDLERS loop — so the
 * "already linked" check sees every meaningful edge first and defers to it.
 */
function buildGenericReferenceTriples(
  records: RawRecord[],
  entities: EntityIndex,
  triples: Triple[],
): void {
  // Undirected pair set of already-connected node pairs (min:max key).
  const linked = new Set<string>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (const t of triples) linked.add(pairKey(t.subject, t.object));

  for (const rec of records) {
    if (isGeometry(rec.type) || isPlacementType(rec.type)) continue;
    if (rec.type.startsWith('IFCREL')) continue;
    if (!entities.has(rec.id)) continue;
    // Split by positional arg so each ref knows which STEP attribute slot it came
    // from; the slot name (ForLayerSet, RelatingStructure, …) becomes the edge
    // detail label. Falls back to `arg{N}` for classes absent from the table.
    const slotNames = IFC_ATTR_NAMES[rec.type];
    const args = splitArgs(rec.args);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      const slot = slotNames?.[i];
      for (const tgt of listRefs(arg)) {
        if (tgt === rec.id) continue;        // no self-loops
        if (!entities.has(tgt)) continue;    // geometry / placement / value → skip
        const key = pairKey(rec.id, tgt);
        if (linked.has(key)) continue;       // already covered by a semantic edge
        linked.add(key);
        triples.push({
          subject: rec.id,
          predicate: 'references',
          object: tgt,
          detail: slot ?? `arg${i}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Core extraction from pre-parsed records (used by both sync and Worker paths)
// ---------------------------------------------------------------------------

export function extractFromRecords(
  records: RawRecord[],
  schema: string,
  filename: string,
  bimUseProfile: BimUseProfileId = 'learning',
  bboxes?: Map<number, [number, number, number, number, number, number]>,
  geomStats?: Map<number, GeomStats>,
): Omit<ParsedModel, 'modelId' | 'accentColor' | 'sha256'> {
  const entities: EntityIndex = new Map();
  const triples: Triple[] = [];

  // Resolve the model's unit table once (IfcUnitAssignment / IfcSIUnit /
  // IfcConversionBasedUnit) so property/quantity values carry real units (PB-B).
  const units = resolveUnits(records);

  for (const rec of records) {
    if (isGeometry(rec.type) || isPlacementType(rec.type)) continue;
    if (rec.type.startsWith('IFCREL')) continue;
    const entity = recordToEntity(rec);
    enrichValueUnit(entity, rec, units);
    // Attach the world bounding box meshed at load time, if this entity produced
    // geometry. Non-physical entities simply have none.
    const box = bboxes?.get(rec.id);
    if (box) entity.bbox = box;
    // Geometry statistics from the same mesh pass as the bbox. Attached even
    // when the mesh was degenerate (no bbox), so a product that meshed to
    // nothing is visible as a zero-vertex element rather than an absent one.
    const gs = geomStats?.get(rec.id);
    if (gs) {
      entity.vertexCount = gs.vertexCount;
      entity.triangleCount = gs.triangleCount;
      entity.uniqueVertexCount = gs.uniqueVertexCount;
      entity.meshPartCount = gs.meshPartCount;
    }
    entities.set(rec.id, entity);
  }

  buildSyntheticTriples(records, entities, triples);

  for (const rec of records) {
    const handler = REL_HANDLERS[rec.type];
    if (!handler) continue;
    const args = splitArgs(rec.args);
    try {
      const newTriples = handler(rec.id, args);
      for (const t of newTriples) {
        if (entities.has(t.subject) && entities.has(t.object)) {
          triples.push(t);
        }
      }
    } catch {
      // Malformed record — skip silently
    }
  }

  // Tier 2 generic fallback — runs last so it defers to every semantic edge.
  buildGenericReferenceTriples(records, entities, triples);

  const filtered = filterTriples(triples, bimUseProfile);
  return { entities, triples: filtered, schema, filename };
}

// ---------------------------------------------------------------------------
// Main extraction entry point — loads via web-ifc WASM
// ---------------------------------------------------------------------------

export async function extractModel(
  buffer: ArrayBuffer,
  filename: string,
  bimUseProfile: BimUseProfileId = 'learning',
  wasmPath?: string,
  onProgress?: (percent: number, parsed: number) => void,
): Promise<Omit<ParsedModel, 'modelId' | 'accentColor' | 'sha256'>> {
  const loader = new IfcLoader();
  await loader.init(wasmPath);
  const { records, schema, bboxes, geomStats } = await loader.load(new Uint8Array(buffer), onProgress);
  loader.dispose();
  return extractFromRecords(records, schema, filename, bimUseProfile, bboxes, geomStats);
}
