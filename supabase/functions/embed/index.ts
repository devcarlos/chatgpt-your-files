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

  for (const row of rows) {
    const { id, [contentColumn]: content } = row;

    if (!content) {
      console.error(`No content available in column '${contentColumn}'`);
      continue;
    }

    try {
      console.log(`🔄 Generating embedding for ${table} id ${id}`);
      
      // Clean and prepare content very aggressively
      let cleanContent = content
        .replace(/\r\n/g, '\n')     // Normalize line endings
        .replace(/\r/g, '\n')       // Handle old Mac line endings
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Remove markdown links [text](url) -> text
        .replace(/\[[^\]]*\]/g, '')  // Remove remaining markdown references [text]
        .replace(/\([^)]*\)/g, '')   // Remove parenthetical content
        .replace(/[^\x20-\x7E\n]/g, '') // Remove non-ASCII characters
        .replace(/[#*_`~]/g, '')     // Remove markdown formatting characters
        .replace(/\s+/g, ' ')        // Normalize whitespace
        .replace(/\n+/g, ' ')        // Convert newlines to spaces
        .trim();                     // Remove leading/trailing whitespace
      
      // Truncate to approximate token limit (512 tokens ≈ 2000-2500 characters)
      if (cleanContent.length > 2000) {
        cleanContent = cleanContent.substring(0, 2000);
        console.log(`📏 Content truncated from ${content.length} to ${cleanContent.length} chars`);
      }
      
      // Skip empty or very short content
      if (cleanContent.length < 10) {
        console.log(`⏭️ Skipping ${table} id ${id} - content too short (${cleanContent.length} chars)`);
        continue;
      }
      
      console.log(`📝 Processing content: ${cleanContent.length} chars`);
      
      // Initialize AI Session per row to avoid worker timeout issues
      let model;
      let output;
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        try {
          // Create fresh AI Session for each attempt
          console.log(`🤖 Initializing AI Session for ${table} id ${id} (attempt ${retryCount + 1})`);
          
          // Use gte-small which is supported by Supabase (produces 384 dimensions)
          // We'll pad to 1024 to match our database schema
          let modelName = 'gte-small';
          
          console.log(`🔧 Using model: ${modelName}`);
          model = new Supabase.ai.Session(modelName);
          
          // Add delay to let worker stabilize
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          output = await model.run(cleanContent, {
            mean_pool: true,
            normalize: true,
          });
          
          // Handle different embedding dimensions based on model
          if (output && output.length !== 1024) {
            if (output.length > 1024) {
              // Truncate if too large
              output = output.slice(0, 1024);
              console.log(`📏 Embedding truncated from ${output.length + (output.length - 1024)} to 1024 dimensions`);
            } else {
              // Pad with zeros if too small (e.g., gte-small produces 384)
              const padding = new Array(1024 - output.length).fill(0);
              output = [...output, ...padding];
              console.log(`📏 Embedding padded from ${output.length - padding.length} to 1024 dimensions`);
            }
          }
          
          console.log(`✅ AI Session successful for ${table} id ${id} - Generated ${output?.length || 0} dimensions using ${modelName}`);
          break; // Success, exit retry loop
        } catch (aiError) {
          retryCount++;
          console.log(`🔄 Retry ${retryCount}/${maxRetries} for ${table} id ${id}: ${aiError.message}`);
          
          if (retryCount >= maxRetries) {
            throw aiError; // Re-throw after max retries
          }
          
          // Wait longer between retries to let workers recover
          await new Promise(resolve => setTimeout(resolve, 3000 * retryCount));
        }
      }

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
