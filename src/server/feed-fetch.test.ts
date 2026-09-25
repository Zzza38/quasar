import {describe,it,expect,vi} from 'vitest';
import {PassThrough} from 'node:stream';
import {fetchFeed,isPublicAddress,MAX_FEED_BYTES,normalizeFeedUrl,type FeedFetchDependencies} from './feed-fetch';

// The production transport runs against a stubbed https.request and DNS, so the tests can check the socket options
// it would connect with (never a real network call). The other tests inject their own transport and are unaffected.
type Lookup = (host:string, options:object, callback:(error:Error|null, address:string, family:number)=>void)=>void;
type Captured = {url:URL; options:{family?:number; agent?:unknown; lookup?:Lookup; headers?:Record<string,string>}; response:PassThrough&{statusCode?:number;headers?:Record<string,string>}};
const net = vi.hoisted(()=>({calls:[] as Captured[], lookup:vi.fn(), onRequest:(_:Captured)=>{}}));
vi.mock('node:dns/promises',()=>({lookup:net.lookup}));
vi.mock('node:https',async()=>{
  const {EventEmitter} = await import('node:events');
  const {PassThrough} = await import('node:stream');
  return {request:(url:URL, options:Captured['options'], callback:(response:Captured['response'])=>void)=>{
    const req = Object.assign(new EventEmitter(),{end:()=>{
      const response = Object.assign(new PassThrough(),{statusCode:200,headers:{}});
      const call = {url,options,response}; net.calls.push(call); callback(response); net.onRequest(call);
    }});
    return req;
  }};
});
const response = (status=200,headers:Record<string,string>={},body='BEGIN:VCALENDAR')=>({status,headers,body:Buffer.from(body)});
const setup = ()=>({resolve:vi.fn<FeedFetchDependencies['resolve']>().mockResolvedValue([{address:'8.8.8.8',family:4}]),transport:vi.fn<FeedFetchDependencies['transport']>().mockResolvedValue(response())});
describe('safe calendar fetching',()=>{
  it('rejects unsafe protocols, ports, credentials and literal hosts',()=>{
    for(const url of ['http://example.com/a','https://u:p@example.com/a','https://example.com:444/a','https://localhost/a','https://127.0.0.1/a','https://[::ffff:127.0.0.1]/a','https://2130706433/a','https://0x7f000001/a']) expect(()=>normalizeFeedUrl(url)).toThrow();
    expect(normalizeFeedUrl('webcal://example.com/a?token=private')).toBe('https://example.com/a?token=private');
  });
  it('denies private, reserved, mapped and transition ranges',()=>{
    for(const ip of ['0.0.0.0','10.1.2.3','127.1.2.3','169.254.169.254','172.31.0.1','192.168.1.1','100.100.100.100','198.18.0.1','192.0.2.1','203.0.113.1','224.0.0.1','::1','fe80::1','fc00::1','::ffff:8.8.8.8','2002:0808:0808::1','2001:db8::1','2001::1','3fff::1']) expect(isPublicAddress(ip),ip).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true); expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects every DNS candidate before connecting',async()=>{
    const deps=setup();deps.resolve.mockResolvedValue([{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]);
    await expect(fetchFeed('https://example.com/feed',{},deps)).rejects.toThrow('public');expect(deps.transport).not.toHaveBeenCalled();
  });
  it('passes the resolved address to pinned transport and retains validators',async()=>{
    const deps=setup();deps.transport.mockResolvedValue(response(200,{etag:'"v2"','last-modified':'today'}));
    expect(await fetchFeed('https://example.com/feed',{etag:'"v1"'},deps)).toMatchObject({status:200,etag:'"v2"'});
    expect(deps.transport.mock.calls[0][1]).toEqual({address:'8.8.8.8',family:4});
    expect(deps.transport.mock.calls[0][2]['if-none-match']).toBe('"v1"');
  });
  it('validates redirects and does not send validators to another origin',async()=>{
    const deps=setup(); deps.transport.mockResolvedValueOnce(response(302,{location:'https://elsewhere.com/feed'})).mockResolvedValueOnce(response(304));
    expect(await fetchFeed('https://example.com/feed',{etag:'private'},deps)).toEqual({status:304});
    expect(deps.resolve).toHaveBeenCalledTimes(2);expect(deps.transport.mock.calls[1][2]['if-none-match']).toBeUndefined();
    deps.transport.mockResolvedValue(response(302,{location:'https://169.254.169.254/latest'}));
    await expect(fetchFeed('https://example.com/feed',{},deps)).rejects.toThrow('public');
  });
  it('rejects oversized, compressed and unsuccessful responses',async()=>{
    for(const result of [response(500),response(200,{'content-encoding':'gzip'}),response(200,{},'x'.repeat(2*1024*1024+1))]) {
      const deps=setup();deps.transport.mockResolvedValue(result);await expect(fetchFeed('https://example.com/feed',{},deps)).rejects.toThrow();
    }
  });
  it('bounds redirect chains and DNS lookup deadlines',async()=>{
    const deps=setup();deps.transport.mockResolvedValue(response(302,{location:'/again'}));await expect(fetchFeed('https://example.com/feed',{},deps)).rejects.toThrow('redirect');expect(deps.transport).toHaveBeenCalledTimes(4);
    vi.useFakeTimers();
    try {deps.resolve.mockImplementation(()=>new Promise(()=>{})); const pending=fetchFeed('https://example.com/feed',{},deps);const assertion=expect(pending).rejects.toThrow('timed out');await vi.advanceTimersByTimeAsync(10001);await assertion;} finally {vi.useRealTimers();}
  });
  describe('production pinned transport',()=>{
    const reset=(onRequest:(call:Captured)=>void)=>{net.calls.length=0;net.lookup.mockReset().mockResolvedValue([{address:'93.184.216.34',family:4}]);net.onRequest=onRequest;};
    it('connects only to the validated address, whatever the hostname resolves to at connect time',async()=>{
      reset(({response})=>{response.end('BEGIN:VCALENDAR');});
      expect(await fetchFeed('https://school.example/feed.ics')).toMatchObject({status:200,text:'BEGIN:VCALENDAR'});
      expect(net.lookup).toHaveBeenCalledTimes(1);
      const [{url,options}] = net.calls;
      expect(url.hostname).toBe('school.example');
      // A fixed family keeps Node's autoSelectFamily from calling lookup with all:true, and no shared agent reuses a socket.
      expect(options).toMatchObject({family:4,agent:false});
      expect(options.lookup).toBeTypeOf('function');
      const pinned = vi.fn();
      options.lookup!('school.example',{family:4},pinned);
      expect(pinned).toHaveBeenCalledWith(null,'93.184.216.34',4);
      // A DNS answer that changed after validation (rebinding to metadata) is never consulted again.
      net.lookup.mockResolvedValue([{address:'169.254.169.254',family:4}]);
      options.lookup!('school.example',{family:4},pinned);
      expect(pinned).toHaveBeenLastCalledWith(null,'93.184.216.34',4);
      expect(net.lookup).toHaveBeenCalledTimes(1);
    });
    it('aborts an oversized body while it is still streaming',async()=>{
      const chunk = Buffer.alloc(1024*1024,'x');
      let written = 0;
      reset(({response})=>{
        // Keep writing until the transport destroys the stream; never end it, so only the streaming cutoff can stop it.
        const pump=()=>{ while(!response.destroyed && written<=MAX_FEED_BYTES*4) { written+=chunk.length; response.write(chunk); } };
        setImmediate(pump);
      });
      await expect(fetchFeed('https://school.example/feed.ics')).rejects.toThrow('2 MB');
      expect(net.calls[0].response.destroyed).toBe(true);
      expect(written).toBeLessThanOrEqual(MAX_FEED_BYTES+chunk.length);
    });
  });
});
