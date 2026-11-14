# Spark yolundan menü çubuğu (şablon) ve uygulama ikonu üretir.
import re, sys, os
from PIL import Image, ImageDraw
src = open(sys.argv[1]).read()
d = re.findall(r'pathData="(m19[^"]+)"', src)[0]
toks = re.findall(r'[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)', d)
polys=[]; cur=[]; x=y=sx=sy=0; i=0; cmd=None
def num():
    global i; v=float(toks[i]); i+=1; return v
def cubic(p0,p1,p2,p3,n=12):
    return [((1-t)**3*p0[0]+3*(1-t)**2*t*p1[0]+3*(1-t)*t*t*p2[0]+t**3*p3[0],(1-t)**3*p0[1]+3*(1-t)**2*t*p1[1]+3*(1-t)*t*t*p2[1]+t**3*p3[1]) for t in [k/n for k in range(1,n+1)]]
while i < len(toks):
    if re.match(r'[A-Za-z]', toks[i]): cmd=toks[i]; i+=1
    if cmd in 'zZ':
        if cur: polys.append(cur); cur=[]
        x,y=sx,sy; cmd=None; continue
    rel=cmd.islower(); c=cmd.lower()
    if c=='m':
        a,b=num(),num(); x,y=(x+a,y+b) if rel else (a,b)
        if cur: polys.append(cur)
        cur=[(x,y)]; sx,sy=x,y; cmd='l' if rel else 'L'
    elif c=='l': a,b=num(),num(); x,y=(x+a,y+b) if rel else (a,b); cur.append((x,y))
    elif c=='h': a=num(); x=x+a if rel else a; cur.append((x,y))
    elif c=='v': a=num(); y=y+a if rel else a; cur.append((x,y))
    elif c=='c':
        v=[num() for _ in range(6)]
        if rel: v=[v[0]+x,v[1]+y,v[2]+x,v[3]+y,v[4]+x,v[5]+y]
        cur+=cubic((x,y),(v[0],v[1]),(v[2],v[3]),(v[4],v[5])); x,y=v[4],v[5]
if cur: polys.append(cur)
def spark(S, frac, color, bg=None):
    img=Image.new('RGBA',(S,S),(0,0,0,0)); dr=ImageDraw.Draw(img)
    if bg: dr.rounded_rectangle([S*0.1,S*0.1,S*0.9-1,S*0.9-1],radius=int(S*0.18),fill=bg)
    sc=S*frac/100; o=(S-100*sc)/2
    for P in polys: dr.polygon([(px*sc+o,py*sc+o) for px,py in P],fill=color)
    return img
out=sys.argv[2]
big=4
spark(64*big,0.92,(0,0,0,255)).resize((64,64),Image.LANCZOS).save(f'{out}/spark.png')
iconset=f'{out}/AppIcon.iconset'; os.makedirs(iconset,exist_ok=True)
base=spark(2048,0.46,(255,255,255,255),bg=(217,119,87,255)).resize((1024,1024),Image.LANCZOS)
for s in [16,32,128,256,512]:
    base.resize((s,s),Image.LANCZOS).save(f'{iconset}/icon_{s}x{s}.png')
    base.resize((s*2,s*2),Image.LANCZOS).save(f'{iconset}/icon_{s}x{s}@2x.png')
