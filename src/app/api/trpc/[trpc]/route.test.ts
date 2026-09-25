import {describe,it,expect,vi,beforeEach} from 'vitest';
const trpc=vi.hoisted(()=>({fetchRequestHandler:vi.fn(async({req}:{req:Request})=>new Response(await req.text()))}));
vi.mock('@trpc/server/adapters/fetch',()=>trpc);
vi.mock('@/server/router',()=>({appRouter:{}}));
vi.mock('@/server/service',()=>({Service:class{}}));
vi.mock('@/server/db',()=>({getDb:()=>({})}));
vi.mock('@/server/auth',()=>({getAuth:async()=>({userId:null,authAt:null})}));
vi.mock('@/server/trpc-log',()=>({logTrpcError:()=>{}}));
import {GET,POST} from './route';
const url='http://localhost/api/trpc/tasks.create';
const headers={origin:'http://localhost','content-type':'application/json'};
/** A chunked body with no Content-Length that yields `chunks` pieces of `size` bytes, recording how much was pulled. */
const chunked=(size:number,chunks:number)=>{
  const state={pulled:0,cancelled:false};
  const body=new ReadableStream<Uint8Array>({
    pull(controller){ if(state.pulled>=size*chunks) return controller.close(); state.pulled+=size; controller.enqueue(new Uint8Array(size).fill(0x20)); },
    cancel(){ state.cancelled=true; }
  });
  return {state,req:new Request(url,{method:'POST',headers,body,duplex:'half'} as RequestInit)};
};
describe('tRPC route body limit',()=>{
  beforeEach(()=>{ delete process.env.NEXTAUTH_URL; trpc.fetchRequestHandler.mockClear(); });
  it('rejects a declared Content-Length over 5,000,000 bytes without reading the body',async()=>{
    const res=await POST(new Request(url,{method:'POST',headers:{...headers,'content-length':'5000001'},body:'{}'}));
    expect(res.status).toBe(413); expect(trpc.fetchRequestHandler).not.toHaveBeenCalled();
  });
  it('stops reading a chunked body without Content-Length once it passes the limit',async()=>{
    const {state,req}=chunked(1_000_000,100);
    const res=await POST(req);
    expect(res.status).toBe(413); expect(trpc.fetchRequestHandler).not.toHaveBeenCalled();
    expect(state.pulled).toBeLessThanOrEqual(7_000_000); expect(state.cancelled).toBe(true);
  });
  it('passes a chunked body at the limit through to tRPC unchanged',async()=>{
    const {req}=chunked(1_000_000,5);
    const res=await POST(req);
    expect(res.status).toBe(200); expect((await res.text()).length).toBe(5_000_000);
  });
  it('forwards method, headers and JSON body of a normal mutation',async()=>{
    const res=await POST(new Request(url,{method:'POST',headers,body:'{"0":{"json":{"title":"é"}}}'}));
    expect(await res.text()).toBe('{"0":{"json":{"title":"é"}}}');
    const forwarded=trpc.fetchRequestHandler.mock.calls[0][0].req;
    expect(forwarded.method).toBe('POST'); expect(forwarded.url).toBe(url); expect(forwarded.headers.get('origin')).toBe('http://localhost');
  });
  it('refuses a request the browser marks as cross-site, queries included',async()=>{
    const get=await GET(new Request('http://localhost/api/trpc/admin.schools',{headers:{'sec-fetch-site':'cross-site'}}));
    expect(get.status).toBe(403);
    expect((await POST(new Request(url,{method:'POST',headers:{...headers,'sec-fetch-site':'cross-site'},body:'{}'}))).status).toBe(403);
    expect(trpc.fetchRequestHandler).not.toHaveBeenCalled();
    expect((await GET(new Request('http://localhost/api/trpc/session',{headers:{'sec-fetch-site':'same-origin'}}))).status).toBe(200);
  });
  it('still checks origin and content type before reading',async()=>{
    expect((await POST(new Request(url,{method:'POST',headers:{...headers,origin:'https://evil.test'},body:'{}'}))).status).toBe(403);
    expect((await POST(new Request(url,{method:'POST',headers:{origin:'http://localhost','content-type':'text/plain'},body:'{}'}))).status).toBe(415);
  });
});
