import {describe,it,expect,vi} from 'vitest';
import {fetchFeed,isPublicAddress,normalizeFeedUrl,type FeedFetchDependencies} from './feed-fetch';
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
});
