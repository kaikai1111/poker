-- Run once in your own Supabase project's SQL Editor.
-- Accounts are verified by Auth in the Edge Function. Browsers cannot read/write
-- these tables directly, even with an authenticated JWT. Secrets stay server-side.
begin;
create table if not exists public.table_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_id text unique not null check (account_id ~ '^[a-z0-9_-]{3,20}$' and account_id not in ('__proto__','constructor','prototype')),
  role text not null default 'player' check (role in ('admin','player')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.table_state (
  id integer primary key check (id=1), revision bigint not null default 0,
  payload jsonb not null
);
insert into public.table_state(id,payload) values(1,
  '{"players":[],"state":{"dataVersion":3,"remaining":1800,"paused":true,"started":false,"prize":0,"startStack":1000,"entries":{},"busts":{},"results":{},"dealerIndex":0,"dealerMinutes":30,"sb":100,"bb":200,"profiles":{},"checkins":{},"seats":{},"reports":{},"history":[]}}')
on conflict(id) do nothing;
create table if not exists public.table_attempts (
  bucket text primary key, count integer not null, reset_at timestamptz not null
);
alter table public.table_members enable row level security;
alter table public.table_state enable row level security;
alter table public.table_attempts enable row level security;
revoke all on public.table_members,public.table_state,public.table_attempts from anon,authenticated;
grant all on public.table_members,public.table_state,public.table_attempts to service_role;

create or replace function public.table_new_member() returns trigger
language plpgsql security definer set search_path='' as $$
declare name text;
begin
  name := lower(split_part(new.email,'@',1));
  if new.email not like '%@table.invalid' then return new; end if;
  -- The role is never read from editable user metadata.
  insert into public.table_members(user_id,account_id) values(new.id,name);
  update public.table_state set revision=revision+1 where id=1;
  return new;
end $$;
drop trigger if exists table_signup on auth.users;
create trigger table_signup after insert on auth.users for each row execute function public.table_new_member();

create or replace function public.table_finish_signup(p_user uuid,p_bootstrap boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.table_state where id=1 for update;
  if p_bootstrap and not exists(select 1 from public.table_members where active and role='admin') then
    update public.table_members set role='admin' where user_id=p_user and active;
    update public.table_state set revision=revision+1 where id=1;
  end if;
end $$;

create or replace function public.table_allow_attempt(p_bucket text,p_limit integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  insert into public.table_attempts as a(bucket,count,reset_at) values(p_bucket,1,now()+interval '1 minute')
  on conflict(bucket) do update set
    count=case when a.reset_at<now() then 1 else a.count+1 end,
    reset_at=case when a.reset_at<now() then now()+interval '1 minute' else a.reset_at end
  returning count into n;
  return n<=p_limit;
end $$;

create or replace function public.table_snapshot(p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.table_members; row public.table_state; s jsonb; item record;
  today text := to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD');
  changed boolean := false; accounts jsonb;
begin
  if p_user is null then
    return jsonb_build_object('user',null,'setupRequired',not exists(select 1 from public.table_members where active));
  end if;
  select * into member from public.table_members where user_id=p_user and active;
  if not found then raise exception 'ACCOUNT_DISABLED'; end if;
  select * into row from public.table_state where id=1 for update;
  s:=row.payload->'state';
  for item in select key,value from jsonb_each(s->'seats') loop
    if item.value->>'day' is distinct from today then
      s:=jsonb_set(s,'{seats}',(s->'seats')-item.key);
      s:=jsonb_set(s,array['checkins',item.key],'false'); changed:=true;
    end if;
  end loop;
  if s ? 'seatInvite' and s->'seatInvite'->>'day' is distinct from today then
    s:=s-'seatInvite'; changed:=true;
  end if;
  if changed then
    s:=s||jsonb_build_object('started',false,'paused',true,'dealerIndex',0,'timerEndsAt',null,'remaining',(s->>'dealerMinutes')::integer*60);
    row.payload:=jsonb_set(row.payload,'{state}',s); row.revision:=row.revision+1;
    update public.table_state set payload=row.payload,revision=row.revision where id=1;
  end if;
  if (s->>'started')::boolean and not (s->>'paused')::boolean and s->>'timerEndsAt' is not null then
    s:=jsonb_set(s,'{remaining}',to_jsonb(greatest(0,ceil((s->>'timerEndsAt')::numeric-extract(epoch from now())))::bigint));
  end if;
  if member.role<>'admin' then s:=s-'seatInvite'; end if;
  select coalesce(jsonb_object_agg(account_id,jsonb_build_object('role',role,'createdAt',created_at)),'{}') into accounts
    from public.table_members where active;
  return row.payload||jsonb_build_object('state',s,'revision',row.revision,'accounts',accounts,
    'user',jsonb_build_object('name',member.account_id,'role',member.role));
end $$;

create or replace function public.table_commit(
  p_user uuid,p_revision bigint,p_payload jsonb,p_accounts jsonb,p_actor_role text
) returns void language plpgsql security definer set search_path='' as $$
declare actor public.table_members; row public.table_state; m public.table_members; desired text;
begin
  select * into row from public.table_state where id=1 for update;
  select * into actor from public.table_members where user_id=p_user and active;
  if not found then raise exception 'ACCOUNT_DISABLED'; end if;
  if row.revision<>p_revision or actor.role<>p_actor_role then raise exception 'REVISION_CONFLICT'; end if;
  if p_accounts is not null then
    if actor.role<>'admin' or p_accounts->actor.account_id->>'role' is distinct from 'admin' then
      raise exception 'ADMIN_REQUIRED';
    end if;
    for m in select * from public.table_members where active loop
      if not (p_accounts ? m.account_id) then
        update public.table_members set active=false where user_id=m.user_id;
      else
        desired:=p_accounts->m.account_id->>'role';
        if desired not in ('admin','player') or desired is null then raise exception 'INVALID_ROLE'; end if;
        update public.table_members set role=desired where user_id=m.user_id;
      end if;
    end loop;
  end if;
  update public.table_state set payload=p_payload,revision=revision+1 where id=1;
end $$;

revoke all on function public.table_new_member() from public,anon,authenticated;
revoke all on function public.table_finish_signup(uuid,boolean) from public,anon,authenticated;
revoke all on function public.table_allow_attempt(text,integer) from public,anon,authenticated;
revoke all on function public.table_snapshot(uuid) from public,anon,authenticated;
revoke all on function public.table_commit(uuid,bigint,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.table_finish_signup(uuid,boolean) to service_role;
grant execute on function public.table_allow_attempt(text,integer) to service_role;
grant execute on function public.table_snapshot(uuid) to service_role;
grant execute on function public.table_commit(uuid,bigint,jsonb,jsonb,text) to service_role;
commit;
