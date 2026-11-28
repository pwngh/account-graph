/**
 * The shape of a new database: every table, key, index, function and trigger, as PostgreSQL itself writes them out.
 * `migrate` runs it once, in the schema it is given. Times are epoch milliseconds.
 */
export function schemaSql(schema: string): string {
  return `
create table ${schema}.alert (
  key text not null,
  text text not null,
  at bigint not null,
  subject text,
  error text,
  tried_at bigint not null,
  delivered_at bigint,
  callback_calls text[]
);
create table ${schema}.apart (
  a text not null,
  b text not null
);
create table ${schema}.built (
  one boolean default true not null,
  policy text not null,
  constraint built_one_check check (one)
);
create table ${schema}.call (
  id text not null,
  subject text not null,
  at bigint not null,
  dialed text not null,
  duration double precision,
  flags text[] not null,
  visitor text,
  recorded_at bigint not null,
  direction text default 'inbound'::text not null,
  tags jsonb,
  party jsonb,
  line_subject text,
  line_kind text,
  constraint call_line_kind_check check ((line_kind = any (array['phone'::text, 'voip'::text, 'none'::text])))
);
create table ${schema}.call_evidence (
  call_id text not null,
  subject text not null,
  identifier text not null,
  at bigint not null,
  recorded_at bigint not null
);
create table ${schema}.call_result (
  id text not null,
  answered boolean,
  voicemail boolean,
  waited double precision,
  recorded_at bigint not null,
  returned_at bigint
);
create table ${schema}.consent_log (
  id bigint not null,
  subject text not null,
  at bigint not null,
  ad_user_data boolean not null,
  ad_personalization boolean not null,
  source text,
  recorded_at bigint not null,
  key text
);
alter table ${schema}.consent_log alter column id add generated always as identity (
  sequence name ${schema}.consent_log_id_seq
  start with 1
  increment by 1
  no minvalue
  no maxvalue
  cache 1
);
create table ${schema}.conversion (
  transaction_id text not null,
  target text not null,
  state text not null,
  due bigint not null,
  attempts integer not null,
  job jsonb not null,
  rev bigint default 0 not null
);
create table ${schema}.cost (
  day text not null,
  source text not null,
  campaign_id text not null,
  campaign text not null,
  amount double precision not null,
  currency text not null,
  clicks bigint not null,
  impressions bigint not null,
  conversions double precision,
  claimed_value double precision,
  read_at bigint,
  read_key text
);
create table ${schema}.decision (
  seq bigint not null,
  at bigint not null,
  action text not null,
  about jsonb not null,
  actor text,
  reason text,
  hash text not null
);
create table ${schema}.body (
  source text not null,
  id text collate "C" not null,
  subject text not null,
  author text,
  at bigint not null,
  recorded_at bigint not null,
  words text not null,
  cut boolean not null,
  primary key (source, id)
);
create index body_subject on ${schema}.body (subject, at);
create index body_recorded on ${schema}.body (recorded_at);
create index body_author on ${schema}.body (author) where author is not null;
create table ${schema}.detail (
  subject text not null,
  field text not null,
  value text not null,
  at bigint not null,
  key text collate "C" not null,
  primary key (subject, field)
);
create table ${schema}.edge (
  subject text not null,
  identifier text not null,
  first_at bigint not null,
  last_at bigint not null,
  sightings integer not null,
  profile_at bigint,
  profile_key text collate pg_catalog."C",
  source_fact text
);
create table ${schema}.event (
  seq bigint not null,
  type text not null,
  at bigint not null,
  data jsonb not null,
  subject text,
  notice_key text,
  callback_calls text[]
);
create table ${schema}.event_delivery (
  sink text not null,
  seq bigint not null,
  due bigint not null,
  attempts integer not null,
  since bigint,
  lease_until bigint not null
);
create table ${schema}.event_head (
  one boolean default true not null,
  seq bigint not null,
  epoch text not null,
  pruned bigint default 0 not null,
  constraint event_head_one_check check (one)
);
create table ${schema}.event_once (
  said_once text not null,
  subject text
);
create table ${schema}.fact_withdrawal (
  subject text not null,
  identifier text not null,
  at bigint not null,
  key text not null collate pg_catalog."C",
  recorded_at bigint not null,
  decision bigint
);
create table ${schema}.feed (
  name text not null,
  last_at bigint,
  watched_at bigint
);
create table ${schema}.flow (
  source text not null,
  target text not null,
  asset text not null,
  transfers integer not null,
  total bigint not null,
  first_at bigint not null,
  last_at bigint not null
);
create table ${schema}.identifier (
  id text not null,
  fanout integer not null,
  ignored boolean default false not null,
  shown text
);
create table ${schema}.job (
  name text not null,
  started_at bigint not null,
  succeeded_at bigint,
  failed_at bigint,
  error text,
  run text,
  outcome text
);
create table ${schema}.job_run (
  id text not null,
  name text not null,
  started_at bigint not null
);
create table ${schema}.lease (
  number text not null,
  subject text not null,
  start_at bigint not null,
  until_at bigint not null
);
create view ${schema}.match_identifier as
 select id,
  (sum(fanout))::integer as fanout,
  bool_or(ignored) as ignored
   from ( select identifier.id,
          identifier.fanout,
          identifier.ignored
         from ${schema}.identifier
      union all
       select w.identifier,
          (count(distinct w.subject))::integer as count,
          false
         from ${schema}.call_evidence w
        where (not (exists ( select
                 from ${schema}.edge e
                where ((e.subject = w.subject) and (e.identifier = w.identifier)))))
        group by w.identifier) counts
  group by id;
create table ${schema}.message (
  id text not null,
  direction text not null,
  subject text not null,
  at bigint not null,
  ours text not null,
  flags text[] not null,
  visitor text,
  tags jsonb,
  recorded_at bigint not null
);
create table ${schema}.not_lead (
  id text not null,
  kind text not null,
  at bigint not null
);
create table ${schema}.outcome (
  transaction_id text not null,
  subject text not null,
  at bigint not null,
  stage text not null,
  value double precision not null,
  currency text not null,
  tags jsonb
);
create table ${schema}.outcome_value (
  id bigint not null,
  transaction_id text not null,
  subject text not null,
  value double precision not null,
  currency text not null,
  at bigint not null,
  kind text,
  why text
);
alter table ${schema}.outcome_value alter column id add generated always as identity (
  sequence name ${schema}.outcome_value_id_seq
  start with 1
  increment by 1
  no minvalue
  no maxvalue
  cache 1
);
create table ${schema}.payment (
  id text not null,
  transaction_id text not null,
  amount double precision not null,
  kind text not null,
  currency text not null
);
create table ${schema}.profile_created (
  subject text not null,
  created_at bigint not null,
  at bigint not null,
  key text not null collate pg_catalog."C"
);
create table ${schema}.pulse (
  one boolean default true not null,
  writes bigint not null,
  constraint pulse_one_check check (one)
);
create table ${schema}.receipt (
  type text not null,
  key_mac text not null,
  secret_id text not null,
  digest jsonb,
  digest_version integer not null,
  ref_type text,
  ref_mac text,
  sent jsonb,
  at bigint not null,
  recorded_at bigint not null,
  forgotten_at bigint
);
create table ${schema}.receipt_subject (
  type text not null,
  key_mac text not null,
  subject text not null
);
create table ${schema}.said (
  topic text not null,
  about text not null,
  key text not null,
  at bigint not null,
  data jsonb not null,
  returned_after bigint
);
create table ${schema}.sent_link (
  id text not null,
  subject text not null,
  purpose text,
  at bigint not null,
  expires_at bigint not null,
  opened_at bigint,
  openings integer not null
);
create table ${schema}.setting (
  name text not null,
  value text not null
);
create table ${schema}.sighting (
  id bigint not null,
  subject text not null,
  identifier text not null,
  at bigint not null,
  event text,
  recorded_at bigint not null,
  profile_key text,
  source_fact text
);
alter table ${schema}.sighting alter column id add generated always as identity (
  sequence name ${schema}.sighting_id_seq
  start with 1
  increment by 1
  no minvalue
  no maxvalue
  cache 1
);
create table ${schema}.subject (
  id text not null,
  component text not null,
  cluster text not null
);
create table ${schema}.text_phone_profile (
  subject text not null,
  line text not null,
  at bigint not null,
  key text not null collate pg_catalog."C"
);
create table ${schema}.text_stop (
  subject text not null,
  line text not null,
  at bigint not null,
  key text not null collate pg_catalog."C",
  through_at bigint,
  through_key text collate pg_catalog."C",
  constraint text_stop_check check (((through_at is null) = (through_key is null)))
);
create table ${schema}.touch (
  id bigint not null,
  subject text not null,
  at bigint not null,
  detail jsonb not null,
  source_call text
);
alter table ${schema}.touch alter column id add generated always as identity (
  sequence name ${schema}.touch_id_seq
  start with 1
  increment by 1
  no minvalue
  no maxvalue
  cache 1
);
create table ${schema}.transfer (
  id text not null,
  source text not null,
  target text not null,
  asset text not null,
  amount bigint not null,
  at bigint not null
);
create table ${schema}.withdrawn_edge (
  subject text not null,
  identifier text not null,
  first_at bigint not null,
  last_at bigint not null,
  sightings integer not null,
  profile_at bigint,
  profile_key text collate pg_catalog."C",
  source_fact text
);
create function ${schema}.keep_pruned_phone_profiles() returns trigger language plpgsql as $$
  begin
  insert into ${schema}.text_phone_profile (subject, line, at, key)
    select s.subject, 'caller:' || substr(s.identifier, strpos(s.identifier, ':') + 1), s.at, s.profile_key from gone s
    where s.profile_key is not null and (starts_with(s.identifier, 'phone:') or starts_with(s.identifier, 'voip:'))
      and exists (select from ${schema}.fact_withdrawal f where f.subject = s.subject
        and f.identifier in ('phone:' || substr(s.identifier, strpos(s.identifier, ':') + 1), 'voip:' || substr(s.identifier, strpos(s.identifier, ':') + 1)))
    on conflict do nothing;
  return null;
  end;
$$;
create function ${schema}.keep_withdrawal_receipt() returns trigger language plpgsql as $$
  begin
  return null;
  end;
$$;
alter table only ${schema}.alert
  add constraint alert_pkey primary key (key);
alter table only ${schema}.apart
  add constraint apart_pkey primary key (a, b);
alter table only ${schema}.built
  add constraint built_pkey primary key (one);
alter table only ${schema}.call_evidence
  add constraint call_evidence_pkey primary key (call_id, subject, identifier);
alter table only ${schema}.call
  add constraint call_pkey primary key (id);
alter table only ${schema}.call_result
  add constraint call_result_pkey primary key (id);
alter table only ${schema}.consent_log
  add constraint consent_log_pkey primary key (id);
alter table only ${schema}.conversion
  add constraint conversion_pkey primary key (transaction_id, target);
alter table only ${schema}.cost
  add constraint cost_pkey primary key (day, source, campaign_id);
alter table only ${schema}.decision
  add constraint decision_pkey primary key (seq);
alter table only ${schema}.edge
  add constraint edge_pkey primary key (subject, identifier);
alter table only ${schema}.event_delivery
  add constraint event_delivery_pkey primary key (sink);
alter table only ${schema}.event_head
  add constraint event_head_pkey primary key (one);
alter table only ${schema}.event_once
  add constraint event_once_pkey primary key (said_once);
alter table only ${schema}.event
  add constraint event_pkey primary key (seq);
alter table only ${schema}.fact_withdrawal
  add constraint fact_withdrawal_pkey primary key (subject, identifier, key);
alter table only ${schema}.feed
  add constraint feed_pkey primary key (name);
alter table only ${schema}.flow
  add constraint flow_pkey primary key (source, target, asset);
alter table only ${schema}.identifier
  add constraint identifier_pkey primary key (id);
alter table only ${schema}.job
  add constraint job_pkey primary key (name);
alter table only ${schema}.job_run
  add constraint job_run_pkey primary key (id);
alter table only ${schema}.lease
  add constraint lease_pkey primary key (number, start_at);
alter table only ${schema}.message
  add constraint message_pkey primary key (id);
alter table only ${schema}.not_lead
  add constraint not_lead_pkey primary key (id);
alter table only ${schema}.outcome
  add constraint outcome_pkey primary key (transaction_id);
alter table only ${schema}.outcome_value
  add constraint outcome_value_pkey primary key (id);
alter table only ${schema}.payment
  add constraint payment_pkey primary key (id);
alter table only ${schema}.profile_created
  add constraint profile_created_pkey primary key (subject);
alter table only ${schema}.pulse
  add constraint pulse_pkey primary key (one);
alter table only ${schema}.receipt
  add constraint receipt_pkey primary key (type, key_mac);
alter table only ${schema}.receipt_subject
  add constraint receipt_subject_pkey primary key (type, key_mac, subject);
alter table only ${schema}.said
  add constraint said_pkey primary key (topic, about, key);
alter table only ${schema}.sent_link
  add constraint sent_link_pkey primary key (id);
alter table only ${schema}.setting
  add constraint setting_pkey primary key (name);
alter table only ${schema}.sighting
  add constraint sighting_pkey primary key (id);
alter table only ${schema}.subject
  add constraint subject_pkey primary key (id);
alter table only ${schema}.text_phone_profile
  add constraint text_phone_profile_pkey primary key (subject, line, at, key);
alter table only ${schema}.text_stop
  add constraint text_stop_pkey primary key (subject, line);
alter table only ${schema}.touch
  add constraint touch_pkey primary key (id);
alter table only ${schema}.transfer
  add constraint transfer_pkey primary key (id);
alter table only ${schema}.withdrawn_edge
  add constraint withdrawn_edge_pkey primary key (subject, identifier);
create index alert_subject on ${schema}.alert using btree (subject);
create index alert_undelivered on ${schema}.alert using btree (at) where (delivered_at is null);
create index apart_b on ${schema}.apart using btree (b);
create index call_at on ${schema}.call using btree (at);
create index call_evidence_identifier on ${schema}.call_evidence using btree (identifier);
create index call_evidence_subject on ${schema}.call_evidence using btree (subject);
create index call_line on ${schema}.call using btree (line_subject) where (line_subject is not null);
create index call_subject on ${schema}.call using btree (subject);
create index call_visitor on ${schema}.call using btree (visitor);
create index callback_alert_calls on ${schema}.alert using gin (callback_calls) where (callback_calls is not null);
create index callback_event_calls on ${schema}.event using gin (callback_calls) where (type = 'callback.overdue'::text);
create index consent_log_subject on ${schema}.consent_log using btree (subject, at);
create index conversion_due on ${schema}.conversion using btree (due) where (state = 'pending'::text);
create index decision_forgotten on ${schema}.decision using btree (((about ->> 0))) where (action = 'forget'::text);
create index decision_pair on ${schema}.decision using btree (((about ->> 0)), ((about ->> 1))) where (action = any (array['join'::text, 'unjoin'::text, 'separate'::text, 'rejoin'::text]));
create index edge_identifier on ${schema}.edge using btree (identifier);
create index event_at on ${schema}.event using btree (at);
create index event_from on ${schema}.event using btree (((data ->> 'from'::text))) where (type = 'cluster.changed'::text);
create index event_subject on ${schema}.event using btree (subject);
create index event_to on ${schema}.event using btree (((data ->> 'to'::text))) where (type = 'cluster.changed'::text);
create index flow_target on ${schema}.flow using btree (target);
create index job_run_name on ${schema}.job_run using btree (name);
create index lease_subject on ${schema}.lease using btree (subject);
create index lease_until on ${schema}.lease using btree (until_at);
create index message_at on ${schema}.message using btree (at);
create index message_subject on ${schema}.message using btree (subject, at);
create index message_visitor on ${schema}.message using btree (visitor);
create index outcome_at on ${schema}.outcome using btree (at);
create index outcome_subject on ${schema}.outcome using btree (subject);
create index outcome_value_subject on ${schema}.outcome_value using btree (subject);
create index outcome_value_transaction on ${schema}.outcome_value using btree (transaction_id, id);
create index payment_transaction on ${schema}.payment using btree (transaction_id);
create index receipt_recorded on ${schema}.receipt using btree (recorded_at);
create index receipt_ref on ${schema}.receipt using btree (ref_type, ref_mac) where (ref_mac is not null);
create index receipt_subject_subject on ${schema}.receipt_subject using btree (subject);
create index said_party_subject on ${schema}.said using btree (((data ->> 'subject'::text))) where (topic = 'party'::text);
create index sent_link_expires on ${schema}.sent_link using btree (expires_at);
create index sent_link_subject on ${schema}.sent_link using btree (subject, at);
create index sighting_recorded on ${schema}.sighting using btree (recorded_at);
create index sighting_subject on ${schema}.sighting using btree (subject, at);
create index subject_cluster on ${schema}.subject using btree (cluster);
create index subject_component on ${schema}.subject using btree (component);
create index subject_id_plain on ${schema}.subject using btree (id collate "C");
create index text_stop_line on ${schema}.text_stop using btree (line);
create index touch_at on ${schema}.touch using btree (at);
create index touch_clicked on ${schema}.touch using gin ((array[(detail ->> 'gclid'::text), (detail ->> 'gbraid'::text), (detail ->> 'wbraid'::text), (detail ->> 'fbclid'::text), (detail ->> 'msclkid'::text), (detail ->> 'ttclid'::text)]));
create index touch_subject on ${schema}.touch using btree (subject, at);
create index transfer_source on ${schema}.transfer using btree (source);
create index transfer_target on ${schema}.transfer using btree (target);
create trigger keep_pruned_phone_profiles after delete on ${schema}.sighting referencing old table as gone for each statement execute function ${schema}.keep_pruned_phone_profiles();
create trigger keep_withdrawal_receipt before delete on ${schema}.receipt for each row when ((old.ref_type = 'withdraw'::text)) execute function ${schema}.keep_withdrawal_receipt();
alter table only ${schema}.call_evidence
  add constraint call_evidence_call_id_fkey foreign key (call_id) references ${schema}.call(id) on delete cascade;
alter table only ${schema}.receipt_subject
  add constraint receipt_subject_type_key_mac_fkey foreign key (type, key_mac) references ${schema}.receipt(type, key_mac) on delete cascade;
insert into ${schema}.pulse (writes) values (0);
insert into ${schema}.event_head (seq, epoch) values (0, substr(md5(random()::text || clock_timestamp()::text), 1, 8));
`
}
