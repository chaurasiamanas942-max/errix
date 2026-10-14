-- Errix usage limits. Run once in Supabase: SQL Editor -> New query -> paste -> Run.

create table if not exists public.usage_daily (
  user_key text not null,
  day date not null,
  chat_requests integer not null default 0,
  voice_requests integer not null default 0,
  primary key (user_key, day)
);

create table if not exists public.global_daily (
  day date primary key,
  chat_requests integer not null default 0,
  voice_requests integer not null default 0
);

-- No policies are created, so only the server's service-role key can read or write these tables.
alter table public.usage_daily enable row level security;
alter table public.global_daily enable row level security;

create or replace function public.consume_quota(
  p_user text,
  p_kind text,
  p_limit integer,
  p_global_limit integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_user_used integer;
  v_global_used integer;
begin
  if p_kind not in ('chat', 'voice') then
    raise exception 'invalid kind';
  end if;

  insert into global_daily (day) values (v_day) on conflict (day) do nothing;
  insert into usage_daily (user_key, day) values (p_user, v_day) on conflict (user_key, day) do nothing;

  -- Lock both rows so simultaneous requests cannot slip past the limit.
  select case when p_kind = 'chat' then chat_requests else voice_requests end
    into v_global_used from global_daily where day = v_day for update;
  select case when p_kind = 'chat' then chat_requests else voice_requests end
    into v_user_used from usage_daily where user_key = p_user and day = v_day for update;

  if v_global_used >= p_global_limit then
    return jsonb_build_object('ok', false, 'reason', 'global');
  end if;
  if v_user_used >= p_limit then
    return jsonb_build_object('ok', false, 'reason', 'user', 'used', v_user_used, 'limit', p_limit);
  end if;

  if p_kind = 'chat' then
    update usage_daily set chat_requests = chat_requests + 1 where user_key = p_user and day = v_day;
    update global_daily set chat_requests = chat_requests + 1 where day = v_day;
  else
    update usage_daily set voice_requests = voice_requests + 1 where user_key = p_user and day = v_day;
    update global_daily set voice_requests = voice_requests + 1 where day = v_day;
  end if;

  return jsonb_build_object('ok', true, 'used', v_user_used + 1, 'limit', p_limit);
end;
$$;

revoke all on function public.consume_quota(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_quota(text, text, integer, integer) to service_role;
