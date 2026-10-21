import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { APICallError } from 'ai';
import { generateOpenAI } from '../src/server/openai';

const previous=process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY='unit-test-key-never-sent';
after(()=>{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;});

const completed={
  status:'completed',
  output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture result'}]}],
  usage:{input_tokens:14,output_tokens:23,output_tokens_details:{reasoning_tokens:19}},
};
const options={model:'gpt-6-luna',system:'Private instructions',prompt:'Private prompt',maxOutputTokens:256};

test('direct Responses request uses fixed host, no storage, low reasoning and full output usage',async()=>{
  let requests=0;
  const result=await generateOpenAI({...options,fetch:async(url,init)=>{
    requests++;
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(init?.method,'POST');
    assert.equal(init?.redirect,'error');
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body,{model:'gpt-6-luna',instructions:options.system,input:options.prompt,max_output_tokens:256,store:false,reasoning:{effort:'low'}});
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer unit-test-key-never-sent');
    return Response.json(completed);
  }});
  assert.equal(requests,1);
  assert.equal(result.text,'Fixture result');
  assert.deepEqual(result.usage,{inputTokens:14,outputTokens:23});
});

test('triage can request no reasoning without changing other model calls',async()=>{
  await generateOpenAI({...options,model:'gpt-6-luna',reasoningEffort:'none',fetch:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body.reasoning,{effort:'none'});
    return Response.json(completed);
  }});
});

test('incomplete or empty output is rejected without leaking provider details',async()=>{
  await assert.rejects(generateOpenAI({...options,fetch:async()=>Response.json({...completed,status:'incomplete',error:{message:'private-provider-detail'}})}),error=>{
    assert(!String(error).includes('private-provider-detail'));return true;
  });
  await assert.rejects(generateOpenAI({...options,fetch:async()=>Response.json({...completed,output:[{type:'reasoning',summary:[]}]})}),/without output text/);
});

test('HTTP 429 is a sanitized typed API error with model-only request metadata and no retry',async()=>{
  let requests=0;
  await assert.rejects(generateOpenAI({...options,fetch:async()=>{
    requests++;
    return new Response(JSON.stringify({error:{message:'private-provider-detail'}}),{status:429,headers:{'retry-after':'3'}});
  }}),error=>{
    assert(APICallError.isInstance(error));
    assert.equal(error.statusCode,429);
    assert.deepEqual(error.requestBodyValues,{model:'gpt-6-luna'});
    assert.equal(error.responseHeaders?.['retry-after'],'3');
    assert.equal(error.responseBody,undefined);
    assert(!String(error).includes(options.prompt));
    assert(!String(error).includes('private-provider-detail'));
    assert(!String(error).includes('unit-test-key'));
    return true;
  });
  assert.equal(requests,1);
});

test('HTTP 5xx remains a typed retryable error without response body',async()=>{
  await assert.rejects(generateOpenAI({...options,fetch:async()=>new Response('private-provider-detail',{status:503})}),error=>{
    assert(APICallError.isInstance(error));
    assert.equal(error.statusCode,503);
    assert.equal(error.isRetryable,true);
    assert.equal(error.responseBody,undefined);
    assert.deepEqual(error.requestBodyValues,{model:options.model});
    return true;
  });
});

test('transport failures are sanitized and external cancellation is linked',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(generateOpenAI({...options,signal:controller.signal,fetch:async(_url,init)=>{
    assert.equal(init?.signal?.aborted,true);
    throw new Error('private-provider-detail');
  }}),error=>{
    assert(!String(error).includes('private-provider-detail'));return true;
  });
});
