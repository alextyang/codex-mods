import struct,mmap,sys
F="/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Codex Framework"
S=sys.argv[1]
stubs={int(l.split()[0],16):l.split()[1] for l in open(S+'/stubs.txt')}
f=open(F,'rb'); mm=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ)
def calls(start, maxins=1500, depth=2, seen=None):
    seen = seen if seen is not None else set()
    out={}
    if start in seen: return out
    seen.add(start)
    for i in range(maxins):
        a=start+4*i
        w=struct.unpack_from('<I',mm,a)[0]
        if (w & 0xFC000000) in (0x94000000,0x14000000):
            imm=w&0x3FFFFFF
            if imm&0x2000000: imm-=1<<26
            t=a+imm*4
            if t in stubs: out[stubs[t]]=out.get(stubs[t],0)+1
            elif depth>0 and 0x4000<=t<0xd2c1648 and not ((w&0xFC000000)==0x14000000 and start<=t<a):
                for k,v in calls(t,600,depth-1,seen).items(): out[k]=out.get(k,0)+v
        if w==0xd65f03c0 and i>3: break
    return out
DC_VM=0xf2c0000; DC_OFF=254541824
vt=int(sys.argv[2],16)
for k in range(0,16):
    v=struct.unpack_from('<Q',mm,DC_OFF+(vt-DC_VM)+8*k)[0]; tgt=v&0xFFFFFFFFF
    c=calls(tgt)
    print(k,hex(8*k),hex(tgt),{n:c[n] for n in c if 'Sec' in n or 'LA' in n or 'Keychain' in n} or '-')
