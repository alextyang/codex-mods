import sys, array, mmap
F="/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Codex Framework"
TEXT_START, TEXT_END = 0x4000, 0x4000+0xd2bd648
targets = {int(a,0):n for a,n in (x.split('=') for x in sys.argv[1:])}
pages = {}
for t,n in targets.items(): pages.setdefault(t & ~0xfff, []).append((t,n))
f=open(F,'rb'); mm=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ)
buf=mm[TEXT_START:TEXT_END]
arr=array.array('I'); arr.frombytes(buf[:len(buf)//4*4])
hits=[]
n=len(arr)
for i in range(n):
    w=arr[i]
    if (w & 0x9F000000)!=0x90000000: continue
    pc=TEXT_START+i*4
    immlo=(w>>29)&3; immhi=(w>>5)&0x7FFFF
    imm=((immhi<<2)|immlo)
    if imm & (1<<20): imm-=1<<21
    page=(pc & ~0xfff)+(imm<<12)
    if page not in pages: continue
    rd=w&31
    for j in range(1,8):
        if i+j>=n: break
        v=arr[i+j]
        # ADD (immediate) 64-bit: sf=1 op=0 S=0 100010 sh imm12 Rn Rd
        if (v & 0xFF800000)==0x91000000 and ((v>>5)&31)==rd:
            off=(v>>10)&0xFFF
            if (v>>22)&1: off<<=12
            addr=page+off
            for t,nm in pages[page]:
                if addr==t: hits.append((pc,nm,addr,i+j))
        # LDR literal-ish via ldr x, [x, #off] pointing into page (for pointers) skip
print(len(hits))
for pc,nm,addr,k in hits: print(hex(pc),nm,hex(addr))
