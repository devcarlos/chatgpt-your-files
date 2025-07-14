// Setup type definitions for built-in Supabase Runtime APIs
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import { createClient } from '@supabase/supabase-js';
import { Database } from '../_lib/database.ts';

const supabaseUrl = Deno.env.get('SUPA_URL');
const supabaseAnonKey = Deno.env.get('SUPA_ANON_KEY');

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (!supabaseUrl || !supabaseAnonKey) {
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

  if (!authorization) {
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

  const { ids, table, contentColumn, embeddingColumn } = await req.json();

  const { data: rows, error: selectError } = await supabase
    .from(table)
    .select(`id, ${contentColumn}` as '*')
    .in('id', ids)
    .is(embeddingColumn, null);

  if (selectError) {
    return new Response(JSON.stringify({ error: selectError }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Initialize the AI model with retry logic
  let model;
  try {
    console.log('🤖 Initializing Supabase AI Session...');
    model = new Supabase.ai.Session('gte-small');
    console.log('✅ AI Session initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize AI Session:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to initialize AI model' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  for (const row of rows) {
    const { id, [contentColumn]: content } = row;

    if (!content) {
      console.error(`No content available in column '${contentColumn}'`);
      continue;
    }

    try {
      console.log(`🔄 Generating embedding for ${table} id ${id}`);
      
      // Clean and prepare content
      let cleanContent = content
        .replace(/\r\n/g, '\n')  // Normalize line endings
        .replace(/\r/g, '\n')    // Handle old Mac line endings
        .trim();                 // Remove leading/trailing whitespace
      
      // More aggressive truncation to avoid Content-Length issues
      if (cleanContent.length > 4000) {
        cleanContent = cleanContent.substring(0, 4000);
        console.log(`📏 Content truncated from ${content.length} to ${cleanContent.length} chars`);
      }
      
      // Skip empty or very short content
      if (cleanContent.length < 10) {
        console.log(`⏭️ Skipping ${table} id ${id} - content too short (${cleanContent.length} chars)`);
        continue;
      }
      
      console.log(`📝 Processing content: ${cleanContent.length} chars`);
      
      const output = await model.run(cleanContent, {
        mean_pool: true,
        normalize: true,
      });

      const embedding = JSON.stringify(output);

      const { error } = await supabase
        .from(table)
        .update({
          [embeddingColumn]: embedding,
        })
        .eq('id', id);

      if (error) {
        console.error(
          `❌ Failed to save embedding on '${table}' table with id ${id}:`,
          error
        );
      } else {
        console.log(
          `✅ Generated embedding for ${table} id ${id}`
        );
      }
    } catch (error) {
      console.error(
        `❌ Failed to generate embedding for ${table} id ${id}:`,
        error
      );
      
      // Log content details for debugging
      console.log(`📊 Content details for id ${id}: length=${content.length}, first 100 chars="${content.substring(0, 100)}"`);
      
      // Continue with next row instead of failing completely
      continue;
    }
  }

  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
