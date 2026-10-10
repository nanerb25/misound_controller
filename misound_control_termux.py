#!/usr/bin/env python3
"""Termux-local Frida controller for the analyzed libmisound.so build."""
import argparse, json, sys
from pathlib import Path
try:
    import frida
except ImportError:
    print('Install with: python -m pip install frida-tools', file=sys.stderr); raise SystemExit(2)

def main():
    p=argparse.ArgumentParser(description='Live MiSound switch and EQ presets (root + matching Frida server required).')
    p.add_argument('target', help='PID of process whose maps contain libmisound.so')
    p.add_argument('--script', default=str(Path(__file__).with_name('misound_agent.js')))
    p.add_argument('--remote', default='127.0.0.1:27042', help='Frida server endpoint')
    args=p.parse_args(); target=int(args.target) if args.target.isdigit() else args.target
    device=frida.get_device_manager().add_remote_device(args.remote)
    session=device.attach(target)
    script=session.create_script(Path(args.script).read_text(encoding='utf-8'))
    def on_message(m, _data):
        if m.get('type')=='send': print('\n[agent] '+json.dumps(m.get('payload'),ensure_ascii=False))
        elif m.get('type')=='error': print('\n[agent error] '+str(m.get('stack') or m.get('description') or m))
    script.on('message',on_message); script.load()
    print('''\nMiSound commands:
  nativeoff / nativeon   Toggle native effect; desired state is reapplied after playback resumes/new handler
  preset bass            Gentle low-frequency boost
  preset treble          Gentle high-frequency boost
  preset clear           Flat 0 dB EQ (NOT the original stock snapshot)
  stockeq                Restore the EQ snapshot captured for the current handler
  eqshow                 Read back the current parameter-3 array
  eq 0,0,0,0,0,0,0,0,0,0  Set 10-band gains in dB (comma-separated)
  hardoff                Optional direct PCM bypass (not normally needed)
  passthrough            Clear direct bypass
  status                 Show hook, enable, and EQ status
  help / quit

Start music and run status if handlerSeen is false. Keep the agent attached for auto-reapply.
''')
    try:
        while True:
            try: line=input('misound> ').strip()
            except (EOFError,KeyboardInterrupt): print('\nType quit to detach.'); continue
            if not line: continue
            parts=line.split(None,1); cmd=parts[0].lower(); arg=parts[1].strip() if len(parts)>1 else ''
            try:
                if cmd in ('quit','exit','q'):
                    st=script.exports_sync.status()
                    if st.get('mode')=='hard': print('Run passthrough or nativeon before quitting to clear the direct bypass.'); continue
                    break
                elif cmd in ('nativeoff','nativeon','hardoff','passthrough','status','eqshow','stockeq'):
                    result=getattr(script.exports_sync,cmd)()
                elif cmd=='preset': result=script.exports_sync.preset(arg)
                elif cmd=='eq':
                    try: values=[float(x.strip()) for x in arg.split(',')]
                    except ValueError: print('Use 10 comma-separated numeric dB values.'); continue
                    if len(values)!=10: print('Please provide exactly 10 values.'); continue
                    result=script.exports_sync.seteq(values)
                elif cmd=='help': print('Commands: nativeoff, nativeon, preset bass|treble|clear, stockeq, eqshow, eq <10 comma-separated dB values>, hardoff, passthrough, status, quit'); continue
                else: print('Unknown command. Type help.'); continue
                print(json.dumps(result,indent=2,ensure_ascii=False))
                if isinstance(result,dict) and result.get('ok') is False: print('Not applied; read the error above.')
            except Exception as e: print('Command failed: '+str(e),file=sys.stderr)
    finally:
        try: script.unload()
        finally: session.detach()
    return 0
if __name__=='__main__': raise SystemExit(main())
