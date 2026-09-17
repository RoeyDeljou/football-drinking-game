/**
 * SPARQL building blocks and result schemas for the Wikidata Query Service.
 *
 * Two queries, both batched with `VALUES` so a whole squad costs a couple of requests:
 *
 * 1. **Candidates by date of birth** — every association football player (P106 = Q937857) born on one of the given
 *    dates (P569), with English/common labels and aliases. Date of birth is indexed, so this is cheap; name matching
 *    then happens client-side, where accents and word order can be handled properly.
 * 2. **Careers** — every "member of sports team" (P54) statement for the matched entities, with start (P580),
 *    end (P582), matches (P1350) and goals (P1351) qualifiers, the team label, and the team's instance-of types so
 *    national and youth teams can be told apart from clubs.
 */

import { z } from 'zod';

/** Q937857 — association football player. */
export const WIKIDATA_FOOTBALLER = 'Q937857';

const bindingValueSchema = z
  .object({
    type: z.string(),
    value: z.string(),
    datatype: z.string().optional(),
    'xml:lang': z.string().optional(),
  })
  .passthrough();

export const sparqlResultsSchema = z
  .object({
    head: z.object({ vars: z.array(z.string()) }).passthrough(),
    results: z.object({ bindings: z.array(z.record(z.string(), bindingValueSchema)) }).passthrough(),
  })
  .passthrough();

export type SparqlResults = z.infer<typeof sparqlResultsSchema>;
export type SparqlBinding = SparqlResults['results']['bindings'][number];

const LABEL_LANGUAGES = ['en', 'mul', 'es', 'it', 'de', 'fr', 'pt'];

/** Only `YYYY-MM-DD` strings make it into a query; anything else is rejected before it can be interpolated. */
export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Only `Q123` ids make it into a query. */
export function isEntityId(value: string): boolean {
  return /^Q\d+$/.test(value);
}

export function candidatesByBirthDateQuery(dates: readonly string[]): string {
  const values = dates
    .filter(isIsoDate)
    .map((date) => `"${date}T00:00:00Z"^^xsd:dateTime`)
    .join(' ');
  const languages = LABEL_LANGUAGES.map((language) => `"${language}"`).join(', ');
  return [
    'SELECT ?player ?dob ?label ?alt WHERE {',
    `  VALUES ?dob { ${values} }`,
    `  ?player wdt:P569 ?dob ; wdt:P106 wd:${WIKIDATA_FOOTBALLER} .`,
    `  OPTIONAL { ?player rdfs:label ?label . FILTER(LANG(?label) IN (${languages})) }`,
    '  OPTIONAL { ?player skos:altLabel ?alt . FILTER(LANG(?alt) = "en") }',
    '}',
  ].join('\n');
}

export function careersQuery(entityIds: readonly string[]): string {
  const values = entityIds
    .filter(isEntityId)
    .map((id) => `wd:${id}`)
    .join(' ');
  return [
    'SELECT ?player ?st ?team ?teamLabel ?start ?end ?matches ?goals',
    '       (GROUP_CONCAT(DISTINCT STR(?type); separator=" ") AS ?types) WHERE {',
    `  VALUES ?player { ${values} }`,
    '  ?player p:P54 ?st .',
    '  ?st ps:P54 ?team .',
    '  OPTIONAL { ?st pq:P580 ?start }',
    '  OPTIONAL { ?st pq:P582 ?end }',
    '  OPTIONAL { ?st pq:P1350 ?matches }',
    '  OPTIONAL { ?st pq:P1351 ?goals }',
    '  OPTIONAL { ?team wdt:P31 ?type }',
    '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }',
    '}',
    'GROUP BY ?player ?st ?team ?teamLabel ?start ?end ?matches ?goals',
  ].join('\n');
}

/** `http://www.wikidata.org/entity/Q2058682` → `Q2058682`. */
export function entityIdFromUri(uri: string): string | null {
  const match = /\/entity\/(Q\d+)$/.exec(uri);
  return match?.[1] ?? null;
}
