import { APICallError } from 'ai';

const RESPONSES_URL='https://api.openai.com/v1/responses';
type GenerateOptions={model:string;system:string;prompt:string;maxOutputTokens:number;reasoningEffort?:'none'|'low';apiKey?:string;signal?:AbortSignal;fetch?:typeof fetch};
type ResponseData={status?:unknown;output?:unknown;usage?:unknown};

function usageTokens(value:unknown):number|undefined{
  return Number.isSafeInteger(value)&&typeof value==='number'&&value>=0?value:undefined;
}

export async function generateOpenAI({model,system,prompt,maxOutputTokens,reasoningEffort,apiKey,signal,fetch:fetchImpl=fetch}:GenerateOptions){
  const key=apiKey===undefined?process.env.OPENAI_API_KEY:apiKey;
  if(!key)throw new Error('OpenAI API is not configured.');
  if(typeof model!=='string'||!model.trim()||!Number.isInteger(maxOutputTokens)||maxOutputTokens<16)throw new Error('Invalid OpenAI request configuration.');
  const body={model,instructions:system,input:prompt,max_output_tokens:maxOutputTokens,store:false,
    ...(/^gpt-[56](?:[.-]|$)/.test(model)?{reasoning:{effort:reasoningEffort??'low'}}:{})};
  const combinedSignal=AbortSignal.any(signal?[signal,AbortSignal.timeout(60_000)]:[AbortSignal.timeout(60_000)]);
  let response:Response;
  try{
    response=await fetchImpl(RESPONSES_URL,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(body),signal:combinedSignal,redirect:'error',cache:'no-store'});
  }catch{
    throw new Error('OpenAI request did not complete.');
  }
  if(!response.ok){
    const statusCode=response.status;
    const retryAfter=response.headers.get('retry-after');
    throw new APICallError({
      message:`OpenAI request failed (HTTP ${statusCode}).`,url:RESPONSES_URL,
      requestBodyValues:{model},statusCode,
      responseHeaders:retryAfter?{'retry-after':retryAfter}:{},
      isRetryable:statusCode===429||statusCode>=500,
    });
  }
  let data:ResponseData;
  try{data=await response.json() as ResponseData;}
  catch{throw new Error('OpenAI returned an invalid response.');}
  if(data?.status!=='completed')throw new Error('OpenAI did not complete the response.');
  const output=Array.isArray(data.output)?data.output:[];
  const text=output.flatMap((item:unknown)=>{
    if(!item||typeof item!=='object')return[];
    const message=item as {type?:unknown;role?:unknown;status?:unknown;content?:unknown};
    if(message.type!=='message'||message.role!=='assistant'||(message.status&&message.status!=='completed')||!Array.isArray(message.content))return[];
    return message.content.flatMap((part:unknown)=>{
      if(!part||typeof part!=='object')return[];
      const content=part as {type?:unknown;text?:unknown};
      return content.type==='output_text'&&typeof content.text==='string'?[content.text]:[];
    });
  }).join('\n').trim();
  if(!text)throw new Error('OpenAI completed without output text.');
  const usage=data.usage&&typeof data.usage==='object'?data.usage as {input_tokens?:unknown;output_tokens?:unknown}:{};
  const inputTokens=usageTokens(usage.input_tokens),outputTokens=usageTokens(usage.output_tokens);
  if(inputTokens===undefined||outputTokens===undefined)throw new Error('OpenAI response did not include valid token usage.');
  return{text,usage:{inputTokens,outputTokens}};
}
