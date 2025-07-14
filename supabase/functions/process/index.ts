import { createClient } from '@supabase/supabase-js';
import { Database } from '../_lib/database.ts';
import { processMarkdown } from '../_lib/markdown-parser.ts';

const supabaseUrl = Deno.env.get('SUPA_URL');
const supabaseAnonKey = Deno.env.get('SUPA_ANON_KEY');

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  console.log('🚀 Process function called');
  
  // Handle CORS
  if (req.method === 'OPTIONS') {
    console.log('📋 CORS preflight request');
    return new Response('ok', { headers: corsHeaders });
  }
  
  console.log('🔧 Environment check:', { supabaseUrl, supabaseAnonKey: !!supabaseAnonKey });
  
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('❌ Missing environment variables');
    return new Response(
      JSON.stringify({
        error: 'Missing environment variables.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const authorization = req.headers.get('Authorization');
  console.log('🔑 Authorization header:', authorization ? 'Present' : 'Missing');

  if (!authorization) {
    console.error('❌ No authorization header');
    return new Response(
      JSON.stringify({ error: `No authorization header passed` }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        authorization,
      },
    },
    auth: {
      persistSession: false,
    },
  });

  const body = await req.json();
  console.log('📦 Request body:', body);
  const { document_id } = body;

  console.log('🔍 Looking for document with ID:', document_id);
  
  const { data: document, error: docError } = await supabase
    .from('documents_with_storage_path')
    .select()
    .eq('id', document_id)
    .single();

  console.log('📄 Document query result:', { document, docError });

  if (!document?.storage_object_path) {
    console.error('❌ Document not found or missing storage path:', document);
    return new Response(
      JSON.stringify({ error: 'Failed to find uploaded document' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  console.log('📁 Downloading file from storage:', document.storage_object_path);

  const { data: file, error: fileError } = await supabase.storage
    .from('files')
    .download(document.storage_object_path);

  console.log('💾 File download result:', { file: !!file, fileError });

  if (!file) {
    console.error('❌ Failed to download file:', fileError);
    return new Response(
      JSON.stringify({ error: 'Failed to download storage object' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  console.log('📖 Reading file contents...');
  const fileContents = await file.text();
  console.log('📝 File contents length:', fileContents.length);
  
  console.log('⚙️ Processing markdown...');
  const processedMd = processMarkdown(fileContents);
  console.log('📊 Processed sections:', processedMd.sections.length);

  console.log('💾 Inserting document sections...');
  const { error } = await supabase.from('document_sections').insert(
    processedMd.sections.map(({ content }) => ({
      document_id,
      content,
    }))
  );

  if (error) {
    console.error('❌ Failed to insert document sections:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to save document sections' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  console.log(
    `✅ Successfully saved ${processedMd.sections.length} sections for file '${document.name}'`
  );

  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
