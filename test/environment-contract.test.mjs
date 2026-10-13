import test from 'node:test';
import assert from 'node:assert/strict';
import {executionEnvironment} from '../src/environment.mjs';
test('Rust environment propagates configured cargo and rustup homes without overwriting PATH',()=>{
 const original=process.env.PATH;
 const e=executionEnvironment({executionHome:'/tmp/devhome',executionEnv:{
  CARGO_HOME:'/tmp/devhome/.cargo',RUSTUP_HOME:'/tmp/devhome/.rustup',
  PATH:'/tmp/devhome/.cargo/bin:/usr/local/bin:/usr/bin:/bin'}});
 assert.equal(e.CARGO_HOME,'/tmp/devhome/.cargo');
 assert.equal(e.RUSTUP_HOME,'/tmp/devhome/.rustup');
 assert.ok(e.PATH.startsWith('/tmp/devhome/.cargo/bin:'));
 assert.equal(process.env.PATH,original);
});
