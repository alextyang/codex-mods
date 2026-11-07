import sys, array, mmap
F="/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Codex Framework"
TEXT_START, TEXT_END = 0x4000, 0x4000+0xd2bd648
targets = {int(a,0):n for a,n in (x.split('=') for x in sys.argv[1:])}
f=open(F,'rb'); mm=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ)
arr=array.array('I'); arr.frombytes(mm[TEXT_START:TEXT_END][:((TEXT_END-TEXT_START)//4)*4])
for i,w in enumerate(arr):
    if (w & 0xFC000000)!=0x94000000: continue
    imm=w&0x3FFFFFF
    if imm & 0x2000000: imm-=1<<26
    t=TEXT_START+i*4+imm*4
    if t in targets: print(hex(TEXT_START+i*4), targets[t])
