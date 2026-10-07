begin;
insert into auth.users values('00000000-0000-0000-0000-000000000001','alice@table.invalid');
insert into auth.users values('00000000-0000-0000-0000-000000000002','bob@table.invalid');
select public.table_finish_signup('00000000-0000-0000-0000-000000000001',true);
do $$
declare view jsonb;
begin
  if has_table_privilege('authenticated','public.table_state','SELECT') then raise exception 'browser can read state'; end if;
  if has_function_privilege('anon','public.table_snapshot(uuid)','EXECUTE') then raise exception 'anon can call privileged RPC'; end if;
  if has_function_privilege('authenticated','public.table_commit(uuid,bigint,jsonb,jsonb,text)','EXECUTE') then raise exception 'browser can mutate state RPC'; end if;
  view:=public.table_snapshot('00000000-0000-0000-0000-000000000001');
  if view->'user'->>'role'<>'admin' then raise exception 'bootstrap failed'; end if;
  if view->'accounts'->'bob'->>'role'<>'player' then raise exception 'registration elevated role'; end if;
  begin
    perform public.table_commit('00000000-0000-0000-0000-000000000001',0,view-'accounts'-'revision'-'user',null,'admin');
    raise exception 'stale revision accepted';
  exception when others then if sqlerrm<>'REVISION_CONFLICT' then raise; end if;
  end;
  if not public.table_allow_attempt('test',1) or public.table_allow_attempt('test',1) then raise exception 'rate limit failed'; end if;
end $$;
update public.table_state set payload=jsonb_set(payload,'{state,seatInvite}',jsonb_build_object('token','ABCD2345','day',to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD'),'createdBy','alice'));
do $$
begin
  if public.table_snapshot('00000000-0000-0000-0000-000000000002')->'state' ? 'seatInvite' then raise exception 'invite leaked to player'; end if;
end $$;
update public.table_state set payload=jsonb_set(jsonb_set(payload,'{state,seats}', '{"bob":{"day":"2000-01-01"}}'),'{state,checkins}','{"bob":true}');
do $$
declare view jsonb;
begin
  view:=public.table_snapshot('00000000-0000-0000-0000-000000000002');
  if (view->'state'->'checkins'->>'bob')::boolean then raise exception 'seat did not expire'; end if;
end $$;
rollback;
