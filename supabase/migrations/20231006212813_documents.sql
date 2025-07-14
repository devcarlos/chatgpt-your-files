create extension if not exists pg_net with schema extensions;
create extension if not exists vector with schema extensions;

create table documents (
  id bigint primary key generated always as identity,
  name text not null,
  storage_object_id uuid not null references storage.objects (id),
  created_by uuid not null references auth.users (id) default auth.uid(),
  created_at timestamp with time zone not null default now()
);

create view documents_with_storage_path
with (security_invoker=true)
as
  select documents.*, storage.objects.name as storage_object_path
  from documents
  join storage.objects
    on storage.objects.id = documents.storage_object_id;

create table document_sections (
  id bigint primary key generated always as identity,
  document_id bigint not null references documents (id),
  content text not null,
  embedding vector (384)
);

create index on document_sections using hnsw (embedding vector_ip_ops);

alter table documents enable row level security;
alter table document_sections enable row level security;

create policy "Users can insert documents"
on documents for insert to authenticated with check (
  auth.uid() = created_by
);

create policy "Users can query their own documents"
on documents for select to authenticated using (
  auth.uid() = created_by
);

create policy "Users can insert document sections"
on document_sections for insert to authenticated with check (
  document_id in (
    select id
    from documents
    where created_by = auth.uid()
  )
);

create policy "Users can update their own document sections"
on document_sections for update to authenticated using (
  document_id in (
    select id
    from documents
    where created_by = auth.uid()
  )
) with check (
  document_id in (
    select id
    from documents
    where created_by = auth.uid()
  )
);

create policy "Users can query their own document sections"
on document_sections for select to authenticated using (
  document_id in (
    select id
    from documents
    where created_by = auth.uid()
  )
);

create function supabase_url()
returns text
language plpgsql
security definer
as $$
begin
  return 'http://kong:8000';
end;
$$;

create function private.handle_storage_update() 
returns trigger 
language plpgsql
as $$
declare
  document_id bigint;
  result int;
begin
  raise notice '🚀 Storage trigger fired for bucket: %, path: %', new.bucket_id, new.name;
  
  -- Only process files in the 'files' bucket
  if new.bucket_id != 'files' then
    raise notice '⏭️ Skipping non-files bucket: %', new.bucket_id;
    return null;
  end if;

  raise notice '📄 Creating document record for file: %', new.path_tokens[2];
  
  insert into documents (name, storage_object_id, created_by)
    values (new.path_tokens[2], new.id, new.owner)
    returning id into document_id;

  raise notice '✅ Document created with ID: %', document_id;
  raise notice '🌐 Calling process function with URL: %', supabase_url() || '/functions/v1/process';

  select
    net.http_post(
      url := supabase_url() || '/functions/v1/process',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
      ),
      body := jsonb_build_object(
        'document_id', document_id
      )
    )
  into result;

  raise notice '📡 HTTP POST result: %', result;

  return null;
end;
$$;

create trigger on_file_upload
  after insert on storage.objects
  for each row
  execute procedure private.handle_storage_update();
