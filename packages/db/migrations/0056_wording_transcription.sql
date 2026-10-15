-- ADR-0123: a policy wording is transcribed, not parsed.
--
-- `axis_documents` holds named extraction fields (`extraction_json`) and never the
-- document's words, so a coverage comparison had no text to compare. This stores
-- the transcription **on the document and pinned to it** — the model that read it,
-- the version, the tier, and when — because two runs may disagree and a diff has
-- to be able to say which reading it used.
ALTER TABLE `axis_documents` ADD `wording_json` text;
