import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, instant, primaryId, updatedAt } from './_shared.ts'
import { sites } from './sites.ts'
import { users } from './auth.ts'

/**
 * Dashboard-defined custom events (mirror of migration 0038).
 *
 * Two tables, and the split is the design: `event_definitions` holds only what
 * must stay stable across edits — the site and the canonical `event_name` the
 * `custom_events_*` rollups group by — while every changeable part lives in an
 * immutable `event_definition_versions` row. Rollback is a publish of a copy
 * rather than a pointer moved backwards, because the tracker-config ETag epoch
 * only ever increases (ADR-0034, D3).
 *
 * `rules` and `property_schema` are JSONB for the reason `funnels.steps` is:
 * they are the payload served to the tracker verbatim. Their contents are
 * validated by `packages/domain/src/no-code-rule.ts`, not by a CHECK — a CSS
 * grammar is not expressible in SQL, and a constraint that tried would be a
 * second implementation of it that could disagree with the real one.
 */

/** Lifecycle of a definition; mirrors `EVENT_DEFINITION_STATUSES`. */
export type EventDefinitionStatus = 'active' | 'archived'

/** One declared property. The allowlist a rule may map to and a template may name. */
export interface EventDefinitionPropertySchemaEntry {
  readonly key: string
  readonly type: 'string' | 'number' | 'boolean'
}

/** One stored rule, in the shape the tracker is served. */
export interface StoredNoCodeRule {
  readonly rule_id: string
  readonly trigger: 'click' | 'submit' | 'url_pattern'
  readonly selector?: string
  readonly url_pattern?: string
  readonly properties?: readonly { key: string; source: string; argument?: string }[]
}

export const eventDefinitions = pgTable(
  'event_definitions',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    eventName: text('event_name').notNull(),
    status: text('status').$type<EventDefinitionStatus>().notNull().default('active'),
    /** Live version number; null means drafted but never published. */
    publishedVersion: integer('published_version'),
    createdByUserId: idColumn('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: instant('archived_at'),
  },
  (t) => [
    index('event_definitions_site_idx').on(t.siteId),
    index('event_definitions_site_published_idx')
      .on(t.siteId)
      .where(sql`archived_at IS NULL AND published_version IS NOT NULL`),
    // Including archived rows: two definitions sharing a name would make the
    // event count for that name a question with two answers, and archiving one
    // does not un-write the ClickHouse rows it produced.
    unique('event_definitions_site_event_name_key').on(t.siteId, t.eventName),
    check(
      'event_definitions_event_name_length_check',
      sql`char_length(${t.eventName}) BETWEEN 1 AND 64`,
    ),
  ],
)

export const eventDefinitionVersions = pgTable(
  'event_definition_versions',
  {
    id: primaryId(),
    definitionId: idColumn('definition_id')
      .notNull()
      .references(() => eventDefinitions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    category: text('category'),
    propertySchema: jsonb('property_schema')
      .$type<EventDefinitionPropertySchemaEntry[]>()
      .notNull()
      .default([]),
    displayTemplate: text('display_template'),
    rules: jsonb('rules').$type<StoredNoCodeRule[]>().notNull().default([]),
    /** Provenance for a rollback copy: "v3 is v1 again". Nothing joins on it. */
    sourceVersion: integer('source_version'),
    createdByUserId: idColumn('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    // No `updatedAt`, deliberately: a version row is never updated after
    // insert, and the column would be an invitation to make it one.
  },
  (t) => [
    index('event_definition_versions_definition_idx').on(t.definitionId, t.version),
    unique('event_definition_versions_definition_version_key').on(t.definitionId, t.version),
    check(
      'event_definition_versions_display_name_length_check',
      sql`char_length(${t.displayName}) BETWEEN 1 AND 200`,
    ),
    check(
      'event_definition_versions_rules_check',
      sql`jsonb_typeof(${t.rules}) = 'array' AND jsonb_array_length(${t.rules}) <= 50`,
    ),
    check(
      'event_definition_versions_property_schema_check',
      sql`jsonb_typeof(${t.propertySchema}) = 'array' AND jsonb_array_length(${t.propertySchema}) <= 32`,
    ),
  ],
)
