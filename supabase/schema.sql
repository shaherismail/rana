-- ============================================================================
-- Millionaire Classroom — Supabase schema
-- Run this in: Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================================

-- Questions table -------------------------------------------------------------
create table if not exists public.questions (
  id              uuid primary key default gen_random_uuid(),
  grade           text not null,             -- e.g. 'Grade 4'
  unit            text not null,             -- e.g. 'Unit 1: Animals'
  difficulty      int  not null default 1    -- 1 (easy) .. 15 (hard)
                  check (difficulty between 1 and 15),
  question        text not null,
  option_a        text not null,
  option_b        text not null,
  option_c        text not null,
  option_d        text not null,
  correct_option  text not null
                  check (correct_option in ('A','B','C','D')),
  explanation     text not null default '',
  image_url       text not null default '',
  audio_text      text not null default '',
  created_at      timestamptz not null default now()
);

-- Helpful index for lesson lookups (grade + unit).
create index if not exists questions_lesson_idx
  on public.questions (grade, unit, difficulty);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- The anon key is public (it lives in the browser), so RLS is the real guard.
-- Classroom policy: anyone with the link may READ questions (the smartboard
-- needs them), but only the teacher may WRITE. Writes are protected by the
-- service-role key, which stays server-side only (see api/generate-questions.js).
-- ----------------------------------------------------------------------------
alter table public.questions enable row level security;

-- Public read access (the game needs questions on the smartboard).
drop policy if exists "questions are readable by anyone" on public.questions;
create policy "questions are readable by anyone"
  on public.questions for select
  to anon, authenticated
  using (true);

-- Writes only via the service role (serverless functions on Vercel).
drop policy if exists "questions writable only by service role" on public.questions;
create policy "questions writable only by service role"
  on public.questions for all
  to service_role
  using (true)
  with check (true);

-- ----------------------------------------------------------------------------
-- Error analytics table (optional — the admin dashboard works on local data
-- too. Use this if you want errors aggregated across devices/lessons.)
-- ----------------------------------------------------------------------------
create table if not exists public.answer_errors (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid references public.questions(id) on delete cascade,
  grade         text not null,
  unit          text not null,
  picked_option text not null,
  created_at    timestamptz not null default now()
);

create index if not exists answer_errors_question_idx
  on public.answer_errors (question_id);

alter table public.answer_errors enable row level security;

drop policy if exists "errors readable by anyone" on public.answer_errors;
create policy "errors readable by anyone"
  on public.answer_errors for select
  to anon, authenticated
  using (true);

drop policy if exists "errors writable only by service role" on public.answer_errors;
create policy "errors writable only by service role"
  on public.answer_errors for insert
  to service_role
  with check (true);