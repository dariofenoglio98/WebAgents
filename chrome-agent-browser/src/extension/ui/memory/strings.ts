/**
 * Every string the memory UI shows (design `memory-ui.md` §9), in one place so the views and
 * their tests cite the same text. `{name}` placeholders are filled by `fill`.
 */
export const STRINGS = {
  "memory.title": "Memory",
  "memory.toggle.graph": "Graph",
  "memory.toggle.list": "List",
  "memory.search.placeholder": "Search records…",
  "memory.new": "+ New record",
  "memory.empty": "Select a record, or press / to search",
  "memory.status": "{records} records · {types} types · {superseded} replaced · store {lock}",
  "memory.status.unlocked": "unlocked (locks in {min} min)",
  "memory.status.unlocked.never": "unlocked",
  "memory.status.locked": "store locked · unlock to edit",
  "memory.link.chooser.title": "Link {source} → {target} as",
  "memory.link.exists": "Already linked",
  "memory.link.cycle": "{target} already replaces {source}, so this would make a loop.",
  "memory.link.superseded_twice": "{target} is already replaced by {other}.",
  "memory.card.replaced": "Replaced by {title} on {date}",
  "memory.card.expired": "Expired on {date}",
  "memory.card.unreadable": "A sealed value cannot be read (the store key changed)",
  "memory.card.where_used": "Used by {package} · {n} runs · last {date}",
  "memory.delete.ask": "Delete {title}? Links to it in other records stay and are shown as missing.",
  "memory.replace.offer": "You already have {title} with the same {fields}.",
  "memory.replace.yes": "Replace it (keeps the old one as replaced)",
  "memory.replace.no": "Keep both",
  "memory.full": "Memory is full ({cap} records). Tidy up to make room.",
  "memory.locked": "Unlock to reveal, edit or share sealed values.",
  "memory.locked.write": "Your memory is locked. Unlock to {action}.",
  "memory.import.self": 'Your "Me" record will be updated from the import (title, fields, body; links combined)',
  "memory.import.restored": "{n} sealed values are restored from your memory ({types})",
  "memory.import.resolved": "{n} link now resolves",
  "memory.review.kept": "Kept from the record it replaces: {items}",
  "memory.review.replaced_since": "replaced since by {title}",
  "memory.review.replace_head": "Replace {title} instead",
  "memory.review.keep_new": "Keep as a new record",
  "memory.export.sealed": "Include sealed values ({n} values of {types})",
  "memory.export.sealed.warn": "They will be written in clear. Keep the file where you keep passwords.",
  "memory.import.report": "{added} will be added · {updated} will update records you already have (newer) · {same} already here",
  "memory.import.incomplete": "{n} record needs a value you must type ({type}: {field})",
  "memory.recall.use": "Use {title}",
  "memory.recall.change": "Change…",
  "memory.recall.none": "Don't share one",
  "memory.recall.ask": "Which {type} may this agent read?",
  "memory.recall.auto": "chosen for you: your most used",
  "memory.recall.empty": "You have no {type} yet.",
  "memory.recall.sealed": "Sealed details ({fields}) go only to {tools}; no model sees them.",
  "memory.review.title": "This agent proposes to remember {n} things",
  "memory.review.from": "From {package} {version}, run {run}, {date}. Nothing is saved until you choose.",
  "memory.review.says": "{package} says: “{rationale}”",
  "memory.review.new_type": "New type: {display_name} — {description}",
  "memory.review.sealed_input": "{field} (sealed, type it to accept)",
  "memory.review.rejected_link": "not saved: you rejected proposal {n}",
  "memory.review.done": "Remembered {n} things",
  "memory.review.not_offered": "{n} proposals not offered ({reason})",
  "memory.agent.none_privacy": "Under the Privacy first preset no agent keeps notes.",
  "memory.forget.ask": "Type forget to delete every record, note and position.",
  "agent.words.read": "read your {type} (you choose which)",
  "agent.words.use": "use {title}",
  "agent.words.propose": "propose things to remember ({types}); you review each one after the run",
  "agent.words.notes": "keep its own notes between runs (at most 32,768 characters), which you can read and clear in Settings",
  "agent.words.no_notes": "keep notes between runs (Privacy first)",
  "migration.title": "Your data moved into Memory.",
} as const;

export type StringKey = keyof typeof STRINGS;

export function fill(key: StringKey, values: Record<string, string | number> = {}): string {
  return STRINGS[key].replace(/\{([a-z_]+)\}/gu, (match, name: string) => (values[name] === undefined ? match : String(values[name])));
}

/** The masked rendering of a sealed value (design §1.3). */
export const MASK = "••••••";
