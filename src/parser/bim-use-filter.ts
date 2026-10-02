import type { Triple } from './types.js';

export type BimUseProfileId =
  | 'learning'
  | 'asset-management'
  | 'qto'
  | 'bcf-ids'
  | 'coordination';

export interface BimUseProfile {
  id: BimUseProfileId;
  label: string;
  description: string;
  /** null means all predicates are allowed */
  allowedPredicates: Set<string> | null;
}

export const BIM_USE_PROFILES: Record<BimUseProfileId, BimUseProfile> = {
  'learning': {
    id: 'learning',
    label: 'Learning',
    description: 'Full graph — all relationship types. Best for exploring a new model.',
    allowedPredicates: null,
  },
  'asset-management': {
    id: 'asset-management',
    label: 'Asset Management',
    description: 'Spatial containment, type definitions, and property sets. For FM and CAFM workflows.',
    allowedPredicates: new Set([
      'IfcRelAggregates',
      'IfcRelNests',
      'IfcRelContainedInSpatialStructure',
      'IfcRelReferencedInSpatialStructure',
      'IfcRelDefinesByType',
      'IfcRelDefinesByProperties',
      'IfcRelAssociatesMaterial',
      'IfcRelAssociatesClassification',
      'IfcRelAssociatesDocument',
      'IfcRelDeclares',
      'hasProperty',
      'hasQuantity',
      'hasMaterial',
      'hasMaterialLayer',
      'hasMaterialLayerSet',
      'hasMaterialProfileSet',
      'hasMaterialConstituent',
      'hasMaterialProfile',
      'hasClassificationReference',
    ]),
  },
  'qto': {
    id: 'qto',
    label: 'QTO',
    description: 'Spatial containment and quantity sets only. For cost estimation and take-off.',
    allowedPredicates: new Set([
      'IfcRelAggregates',
      'IfcRelContainedInSpatialStructure',
      'IfcRelDefinesByType',
      'IfcRelDefinesByProperties',
      'hasQuantity',
    ]),
  },
  'bcf-ids': {
    id: 'bcf-ids',
    label: 'BCF / IDS',
    description: 'Spatial containment and type hierarchy. Minimal graph for issue management.',
    allowedPredicates: new Set([
      'IfcRelAggregates',
      'IfcRelNests',
      'IfcRelContainedInSpatialStructure',
      'IfcRelDefinesByType',
      'IfcRelDeclares',
    ]),
  },
  'coordination': {
    id: 'coordination',
    label: 'Coordination',
    description: 'Containment, openings, connections, and interference. For clash detection review.',
    allowedPredicates: new Set([
      'IfcRelAggregates',
      'IfcRelNests',
      'IfcRelContainedInSpatialStructure',
      'IfcRelReferencedInSpatialStructure',
      'IfcRelVoidsElement',
      'IfcRelFillsElement',
      'IfcRelConnectsElements',
      'IfcRelConnectsPathElements',
      'IfcRelConnectsPorts',
      'IfcRelConnectsPortToElement',
      'IfcRelInterferesElements',
      'IfcRelProjectsElement',
      'IfcRelAdheresToElement',
      'IfcRelSpaceBoundary',
      'IfcRelDefinesByType',
    ]),
  },
};

/** Returns a filtered copy of the triples array, keeping only allowed predicates. */
export function filterTriples(triples: Triple[], profileId: BimUseProfileId): Triple[] {
  const profile = BIM_USE_PROFILES[profileId];
  if (profile.allowedPredicates === null) return triples;
  return triples.filter(t => profile.allowedPredicates!.has(t.predicate));
}
