(module
 (type $0 (func (param i32 i32) (result i32)))
 (type $1 (func (param i32) (result i32)))
 (type $2 (func (param i32)))
 (type $3 (func (param i32 i32)))
 (type $4 (func (param i32 i64)))
 (type $5 (func (param i32 i32 i32 i32) (result i32)))
 (type $6 (func (param i32) (result i64)))
 (type $7 (func (param f64 i32) (result f64)))
 (type $8 (func))
 (type $9 (func (param i32) (result f64)))
 (type $10 (func (param i64) (result i32)))
 (type $11 (func (param i32 i32 i32)))
 (type $12 (func (param i32 i32) (result i64)))
 (global $~lib/rt/stub/offset (mut i32) (i32.const 0))
 (global $~argumentsLength (mut i32) (i32.const 0))
 (global $~lib/util/string/__fixmulShift (mut i64) (i64.const 0))
 (memory $0 1 64)
 (data $0 (i32.const 1036) "\1c")
 (data $0.1 (i32.const 1048) "\02")
 (data $1 (i32.const 1068) "\1c")
 (data $1.1 (i32.const 1080) "\01")
 (data $2 (i32.const 1100) "\1c")
 (data $2.1 (i32.const 1112) "\01")
 (data $3 (i32.const 1132) "\1c")
 (data $3.1 (i32.const 1144) "\01")
 (data $4 (i32.const 1164) "\1c")
 (data $4.1 (i32.const 1176) "\02\00\00\00\02\00\00\00\08")
 (data $5 (i32.const 1196) "\1c")
 (data $5.1 (i32.const 1208) "\02\00\00\00\02\00\00\00\0c")
 (data $6 (i32.const 1228) "\1c")
 (data $6.1 (i32.const 1240) "\02\00\00\00\02\00\00\00\n")
 (data $7 (i32.const 1260) "\1c")
 (data $7.1 (i32.const 1272) "\02\00\00\00\02\00\00\00\r")
 (data $8 (i32.const 1292) "\1c")
 (data $8.1 (i32.const 1304) "\02\00\00\00\02\00\00\00\t")
 (data $9 (i32.const 1324) "\1c")
 (data $9.1 (i32.const 1336) "\02\00\00\00\08\00\00\00t\00r\00u\00e")
 (data $10 (i32.const 1356) "\1c")
 (data $10.1 (i32.const 1368) "\02\00\00\00\n\00\00\00f\00a\00l\00s\00e")
 (data $11 (i32.const 1388) "\1c")
 (data $11.1 (i32.const 1400) "\02\00\00\00\08\00\00\00n\00u\00l\00l")
 (data $12 (i32.const 1430) "\f0?\00\00\00\00\00\00$@\00\00\00\00\00\00Y@\00\00\00\00\00@\8f@\00\00\00\00\00\88\c3@\00\00\00\00\00j\f8@\00\00\00\00\80\84.A\00\00\00\00\d0\12cA\00\00\00\00\84\d7\97A\00\00\00\00e\cd\cdA\00\00\00 _\a0\02B\00\00\00\e8vH7B\00\00\00\a2\94\1amB\00\00@\e5\9c0\a2B\00\00\90\1e\c4\bc\d6B\00\004&\f5k\0cC\00\80\e07y\c3AC\00\a0\d8\85W4vC\00\c8Ngm\c1\abC\00=\91`\e4X\e1C@\8c\b5x\1d\af\15DP\ef\e2\d6\e4\1aKD\92\d5M\06\cf\f0\80D")
 (data $13 (i32.const 1612) ",")
 (data $13.1 (i32.const 1624) "\02\00\00\00\10\00\00\00c\00u\00r\00r\00e\00n\00c\00y")
 (data $14 (i32.const 1660) ",")
 (data $14.1 (i32.const 1672) "\02\00\00\00\18\00\00\00t\00a\00x\00_\00r\00a\00t\00e\00_\00b\00p\00s")
 (data $15 (i32.const 1708) "\1c")
 (data $15.1 (i32.const 1720) "\02\00\00\00\n\00\00\00i\00t\00e\00m\00s")
 (data $16 (i32.const 1740) "\1c")
 (data $16.1 (i32.const 1752) "\02\00\00\00\02\00\00\00,")
 (data $17 (i32.const 1772) "\1c")
 (data $17.1 (i32.const 1784) "\02\00\00\00\02\00\00\00{")
 (data $18 (i32.const 1804) "\1c")
 (data $18.1 (i32.const 1816) "\02\00\00\00\02\00\00\00\"")
 (data $19 (i32.const 1836) "\1c")
 (data $19.1 (i32.const 1848) "\02\00\00\00\04\00\00\00\\\00\"")
 (data $20 (i32.const 1868) "\1c")
 (data $20.1 (i32.const 1880) "\02\00\00\00\04\00\00\00\\\00\\")
 (data $21 (i32.const 1900) "\1c")
 (data $21.1 (i32.const 1912) "\02\00\00\00\04\00\00\00\\\00n")
 (data $22 (i32.const 1932) "\1c")
 (data $22.1 (i32.const 1944) "\02\00\00\00\04\00\00\00\\\00r")
 (data $23 (i32.const 1964) "\1c")
 (data $23.1 (i32.const 1976) "\02\00\00\00\04\00\00\00\\\00t")
 (data $24 (i32.const 1996) "\1c")
 (data $24.1 (i32.const 2008) "\02\00\00\00\04\00\00\00\\\00u")
 (data $25 (i32.const 2028) "\1c")
 (data $25.1 (i32.const 2040) "\02\00\00\00\06\00\00\000\000\000")
 (data $26 (i32.const 2060) "\1c")
 (data $26.1 (i32.const 2072) "\02\00\00\00\02\00\00\000")
 (data $27 (i32.const 2092) "\\")
 (data $27.1 (i32.const 2104) "\02\00\00\00H\00\00\000\001\002\003\004\005\006\007\008\009\00a\00b\00c\00d\00e\00f\00g\00h\00i\00j\00k\00l\00m\00n\00o\00p\00q\00r\00s\00t\00u\00v\00w\00x\00y\00z")
 (data $28 (i32.const 2188) "\1c")
 (data $28.1 (i32.const 2200) "\02\00\00\00\02\00\00\00:")
 (data $29 (i32.const 2220) "\1c")
 (data $29.1 (i32.const 2232) "\02\00\00\00\n\00\00\00l\00i\00n\00e\00s")
 (data $30 (i32.const 2252) "\1c")
 (data $30.1 (i32.const 2264) "\02\00\00\00\02\00\00\00[")
 (data $31 (i32.const 2284) "\1c")
 (data $31.1 (i32.const 2296) "\02\00\00\00\n\00\00\00l\00a\00b\00e\00l")
 (data $32 (i32.const 2316) ",")
 (data $32.1 (i32.const 2328) "\02\00\00\00\18\00\00\00a\00m\00o\00u\00n\00t\00_\00c\00e\00n\00t\00s")
 (data $33 (i32.const 2364) ",")
 (data $33.1 (i32.const 2376) "\02\00\00\00\10\00\00\00q\00u\00a\00n\00t\00i\00t\00y")
 (data $34 (i32.const 2412) ",")
 (data $34.1 (i32.const 2424) "\02\00\00\00\16\00\00\00t\00o\00t\00a\00l\00_\00c\00e\00n\00t\00s")
 (data $35 (i32.const 2460) "\1c")
 (data $35.1 (i32.const 2472) "\02\00\00\00\02\00\00\00}")
 (data $36 (i32.const 2492) "\1c")
 (data $36.1 (i32.const 2504) "\02\00\00\00\02\00\00\00]")
 (data $37 (i32.const 2524) ",")
 (data $37.1 (i32.const 2536) "\02\00\00\00\1c\00\00\00s\00u\00b\00t\00o\00t\00a\00l\00_\00c\00e\00n\00t\00s")
 (data $38 (i32.const 2572) ",")
 (data $38.1 (i32.const 2584) "\02\00\00\00\12\00\00\00t\00a\00x\00_\00c\00e\00n\00t\00s")
 (export "alloc" (func $assembly/index/alloc))
 (export "run" (func $assembly/index/run))
 (export "memory" (memory $0))
 (start $~start)
 (func $~lib/string/String.__concat (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  i32.const 1056
  local.set $2
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const -2
  i32.and
  local.tee $3
  local.get $1
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const -2
  i32.and
  local.tee $4
  i32.add
  local.tee $5
  if
   local.get $5
   i32.const 2
   call $~lib/rt/stub/__new
   local.tee $2
   local.get $0
   local.get $3
   memory.copy
   local.get $2
   local.get $3
   i32.add
   local.get $1
   local.get $4
   memory.copy
  end
  local.get $2
 )
 (func $assembly/index/Parser#peek (param $0 i32) (result i32)
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
  i32.lt_s
  if (result i32)
   local.get $0
   i32.load
   local.get $0
   i32.load offset=4
   call $~lib/string/String#charCodeAt
  else
   i32.const -1
  end
 )
 (func $~lib/rt/stub/__new (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $0
  i32.const 1073741804
  i32.gt_u
  if
   unreachable
  end
  local.get $0
  i32.const 16
  i32.add
  call $~lib/rt/stub/__alloc
  local.tee $3
  i32.const 4
  i32.sub
  local.tee $2
  i32.const 0
  i32.store offset=4
  local.get $2
  i32.const 0
  i32.store offset=8
  local.get $2
  local.get $1
  i32.store offset=12
  local.get $2
  local.get $0
  i32.store offset=16
  local.get $3
  i32.const 16
  i32.add
 )
 (func $assembly/index/Parser#next (param $0 i32) (result i32)
  (local $1 i32)
  local.get $0
  i32.load offset=4
  local.get $0
  i32.load
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
  i32.ge_s
  if
   unreachable
  end
  local.get $0
  i32.load
  local.get $0
  local.get $0
  i32.load offset=4
  local.tee $0
  i32.const 1
  i32.add
  i32.store offset=4
  local.get $0
  call $~lib/string/String#charCodeAt
 )
 (func $assembly/index/Parser#skipSpace (param $0 i32)
  (local $1 i32)
  loop $while-continue|0
   local.get $0
   i32.load offset=4
   local.get $0
   i32.load
   i32.const 20
   i32.sub
   i32.load offset=16
   i32.const 1
   i32.shr_u
   i32.lt_s
   if
    local.get $0
    i32.load
    local.get $0
    i32.load offset=4
    call $~lib/string/String#charCodeAt
    local.tee $1
    i32.const 9
    i32.eq
    local.get $1
    i32.const 32
    i32.eq
    i32.or
    local.get $1
    i32.const 10
    i32.eq
    i32.or
    local.get $1
    i32.const 13
    i32.eq
    i32.or
    if
     local.get $0
     local.get $0
     i32.load offset=4
     i32.const 1
     i32.add
     i32.store offset=4
     br $while-continue|0
    end
   end
  end
 )
 (func $assembly/index/Writer#key (param $0 i32) (param $1 i32) (result i32)
  local.get $0
  call $assembly/index/Writer#separator
  local.get $0
  local.get $0
  i32.load
  local.get $1
  call $assembly/index/Writer.quote
  i32.const 2208
  call $~lib/string/String.__concat
  call $~lib/string/String.__concat
  i32.store
  local.get $0
  i32.const 0
  i32.store8 offset=4
  local.get $0
 )
 (func $assembly/index/Writer#integer (param $0 i32) (param $1 i64)
  local.get $0
  call $assembly/index/Writer#separator
  local.get $0
  local.get $0
  i32.load
  local.get $1
  call $~lib/util/number/itoa64
  call $~lib/string/String.__concat
  i32.store
 )
 (func $assembly/index/Json#field (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  local.get $0
  i32.load
  i32.const 5
  i32.ne
  if
   unreachable
  end
  loop $for-loop|0
   local.get $2
   local.get $0
   i32.load offset=40
   i32.load offset=12
   i32.lt_s
   if
    local.get $0
    i32.load offset=40
    local.get $2
    call $~lib/array/Array<~lib/string/String>#__get
    local.get $1
    call $~lib/string/String.__eq
    if
     local.get $0
     i32.load offset=44
     local.get $2
     call $~lib/array/Array<~lib/string/String>#__get
     return
    end
    local.get $2
    i32.const 1
    i32.add
    local.set $2
    br $for-loop|0
   end
  end
  unreachable
 )
 (func $~lib/string/String#charCodeAt (param $0 i32) (param $1 i32) (result i32)
  local.get $1
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
  i32.ge_u
  if
   i32.const -1
   return
  end
  local.get $0
  local.get $1
  i32.const 1
  i32.shl
  i32.add
  i32.load16_u
 )
 (func $assembly/index/Writer#separator (param $0 i32)
  local.get $0
  i32.load8_u offset=4
  if
   local.get $0
   local.get $0
   i32.load
   i32.const 1760
   call $~lib/string/String.__concat
   i32.store
  end
  local.get $0
  i32.const 1
  i32.store8 offset=4
 )
 (func $assembly/index/Json#constructor (param $0 i32) (result i32)
  (local $1 i32)
  i32.const 48
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $1
  i32.const 0
  i32.store
  local.get $1
  i32.const 0
  i32.store8 offset=4
  local.get $1
  f64.const 0
  f64.store offset=8
  local.get $1
  i32.const 0
  i32.store8 offset=16
  local.get $1
  i64.const 0
  i64.store offset=24
  local.get $1
  i32.const 1056
  i32.store offset=32
  local.get $1
  i32.const 5
  i32.const 1088
  call $~lib/rt/__newArray
  i32.store offset=36
  local.get $1
  i32.const 6
  i32.const 1120
  call $~lib/rt/__newArray
  i32.store offset=40
  local.get $1
  i32.const 5
  i32.const 1152
  call $~lib/rt/__newArray
  i32.store offset=44
  local.get $1
  local.get $0
  i32.store
  local.get $1
 )
 (func $~lib/string/String.fromCharCode@varargs (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  block $1of1
   block $0of1
    block $outOfRange
     global.get $~argumentsLength
     i32.const 1
     i32.sub
     br_table $0of1 $1of1 $outOfRange
    end
    unreachable
   end
   i32.const -1
   local.set $1
  end
  i32.const 2
  local.get $1
  i32.const 0
  i32.gt_s
  local.tee $3
  i32.shl
  i32.const 2
  call $~lib/rt/stub/__new
  local.tee $2
  local.get $0
  i32.store16
  local.get $3
  if
   local.get $2
   local.get $1
   i32.store16 offset=2
  end
  local.get $2
 )
 (func $~lib/array/Array<~lib/string/String>#__get (param $0 i32) (param $1 i32) (result i32)
  local.get $1
  local.get $0
  i32.load offset=12
  i32.ge_u
  if
   unreachable
  end
  local.get $0
  i32.load offset=4
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  i32.load
  local.tee $0
  i32.eqz
  if
   unreachable
  end
  local.get $0
 )
 (func $~lib/rt/stub/__alloc (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  local.get $0
  i32.const 1073741820
  i32.gt_u
  if
   unreachable
  end
  global.get $~lib/rt/stub/offset
  global.get $~lib/rt/stub/offset
  i32.const 4
  i32.add
  local.tee $2
  local.get $0
  i32.const 19
  i32.add
  i32.const -16
  i32.and
  i32.const 4
  i32.sub
  local.tee $0
  i32.add
  call $~lib/rt/stub/maybeGrowMemory
  local.get $0
  i32.store
  local.get $2
 )
 (func $~lib/rt/__newArray (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  i32.const 0
  i32.const 1
  call $~lib/rt/stub/__new
  local.set $2
  local.get $1
  if
   local.get $2
   local.get $1
   i32.const 0
   memory.copy
  end
  i32.const 16
  local.get $0
  call $~lib/rt/stub/__new
  local.tee $0
  local.get $2
  i32.store
  local.get $0
  local.get $2
  i32.store offset=4
  local.get $0
  i32.const 0
  i32.store offset=8
  local.get $0
  i32.const 0
  i32.store offset=12
  local.get $0
 )
 (func $~lib/array/Array<~lib/string/String>#push (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  local.get $0
  i32.load offset=12
  local.tee $3
  i32.const 1
  i32.add
  local.tee $4
  local.get $0
  i32.load offset=8
  local.tee $2
  i32.const 2
  i32.shr_u
  i32.gt_u
  if
   local.get $4
   i32.const 268435455
   i32.gt_u
   if
    unreachable
   end
   local.get $2
   local.get $0
   i32.load
   local.tee $5
   i32.const 1073741820
   local.get $2
   i32.const 1
   i32.shl
   local.tee $6
   local.get $6
   i32.const 1073741820
   i32.ge_u
   select
   local.tee $6
   i32.const 8
   local.get $4
   local.get $4
   i32.const 8
   i32.le_u
   select
   i32.const 2
   i32.shl
   local.tee $7
   local.get $6
   local.get $7
   i32.gt_u
   select
   local.tee $6
   call $~lib/rt/stub/__renew
   local.tee $7
   i32.add
   i32.const 0
   local.get $6
   local.get $2
   i32.sub
   memory.fill
   local.get $5
   local.get $7
   i32.ne
   if
    local.get $0
    local.get $7
    i32.store
    local.get $0
    local.get $7
    i32.store offset=4
   end
   local.get $0
   local.get $6
   i32.store offset=8
  end
  local.get $0
  i32.load offset=4
  local.get $3
  i32.const 2
  i32.shl
  i32.add
  local.get $1
  i32.store
  local.get $0
  local.get $4
  i32.store offset=12
 )
 (func $assembly/index/Parser#value (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  i32.const 32
  i32.gt_s
  if
   unreachable
  end
  local.get $0
  call $assembly/index/Parser#peek
  local.tee $2
  i32.const 123
  i32.eq
  if
   local.get $0
   local.get $1
   call $assembly/index/Parser#object
   return
  end
  local.get $2
  i32.const 91
  i32.eq
  if
   local.get $0
   call $assembly/index/Parser#next
   i32.const 91
   i32.ne
   if
    unreachable
   end
   i32.const 4
   call $assembly/index/Json#constructor
   local.set $2
   local.get $0
   call $assembly/index/Parser#skipSpace
   block $__inlined_func$assembly/index/Parser#array$134
    local.get $0
    call $assembly/index/Parser#peek
    i32.const 93
    i32.eq
    if
     local.get $0
     local.get $0
     i32.load offset=4
     i32.const 1
     i32.add
     i32.store offset=4
     br $__inlined_func$assembly/index/Parser#array$134
    end
    loop $while-continue|0
     local.get $0
     call $assembly/index/Parser#skipSpace
     local.get $2
     i32.load offset=36
     local.get $0
     local.get $1
     i32.const 1
     i32.add
     call $assembly/index/Parser#value
     call $~lib/array/Array<~lib/string/String>#push
     local.get $0
     call $assembly/index/Parser#skipSpace
     local.get $0
     call $assembly/index/Parser#next
     local.tee $3
     i32.const 93
     i32.eq
     br_if $__inlined_func$assembly/index/Parser#array$134
     local.get $3
     i32.const 44
     i32.eq
     br_if $while-continue|0
    end
    unreachable
   end
   local.get $2
   return
  end
  local.get $2
  i32.const 34
  i32.eq
  if
   i32.const 3
   call $assembly/index/Json#constructor
   local.tee $1
   local.get $0
   call $assembly/index/Parser#string
   i32.store offset=32
   local.get $1
   return
  end
  local.get $2
  i32.const 116
  i32.eq
  if
   local.get $0
   i32.const 1344
   i32.const 1
   i32.const 1
   call $assembly/index/Parser#literal
   return
  end
  local.get $2
  i32.const 102
  i32.eq
  if
   local.get $0
   i32.const 1376
   i32.const 1
   i32.const 0
   call $assembly/index/Parser#literal
   return
  end
  local.get $2
  i32.const 110
  i32.eq
  if
   local.get $0
   i32.const 1408
   i32.const 0
   i32.const 0
   call $assembly/index/Parser#literal
   return
  end
  local.get $2
  i32.const 57
  i32.le_s
  local.get $2
  i32.const 48
  i32.ge_s
  i32.and
  local.get $2
  i32.const 45
  i32.eq
  i32.or
  if
   local.get $0
   call $assembly/index/Parser#number
   return
  end
  unreachable
 )
 (func $assembly/index/Parser#literal (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (result i32)
  (local $4 i32)
  (local $5 i32)
  loop $for-loop|0
   local.get $4
   local.get $1
   i32.const 20
   i32.sub
   i32.load offset=16
   i32.const 1
   i32.shr_u
   i32.lt_s
   if
    local.get $1
    local.get $4
    call $~lib/string/String#charCodeAt
    local.set $5
    local.get $0
    call $assembly/index/Parser#next
    local.get $5
    i32.ne
    if
     unreachable
    end
    local.get $4
    i32.const 1
    i32.add
    local.set $4
    br $for-loop|0
   end
  end
  local.get $2
  call $assembly/index/Json#constructor
  local.tee $0
  local.get $3
  i32.store8 offset=4
  local.get $0
 )
 (func $assembly/index/Json#asInt (param $0 i32) (result i64)
  local.get $0
  i32.load
  i32.const 2
  i32.ne
  if (result i32)
   i32.const 0
  else
   local.get $0
   i32.load8_u offset=16
  end
  i32.eqz
  if
   unreachable
  end
  local.get $0
  i64.load offset=24
 )
 (func $~lib/string/String.__eq (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  local.get $1
  i32.eq
  if
   i32.const 1
   return
  end
  local.get $1
  i32.eqz
  local.get $0
  i32.eqz
  i32.or
  if
   i32.const 0
   return
  end
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
  local.tee $3
  local.get $1
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
  i32.ne
  if
   i32.const 0
   return
  end
  block $__inlined_func$~lib/util/string/compareImpl$10 (result i32)
   local.get $0
   local.tee $2
   i32.const 7
   i32.and
   local.get $1
   i32.const 7
   i32.and
   i32.or
   i32.eqz
   local.get $3
   local.tee $0
   i32.const 4
   i32.ge_u
   i32.and
   if
    loop $do-loop|0
     local.get $2
     i64.load
     local.get $1
     i64.load
     i64.eq
     if
      local.get $2
      i32.const 8
      i32.add
      local.set $2
      local.get $1
      i32.const 8
      i32.add
      local.set $1
      local.get $0
      i32.const 4
      i32.sub
      local.tee $0
      i32.const 4
      i32.ge_u
      br_if $do-loop|0
     end
    end
   end
   loop $while-continue|1
    local.get $0
    local.tee $3
    i32.const 1
    i32.sub
    local.set $0
    local.get $3
    if
     local.get $2
     i32.load16_u
     local.tee $3
     local.get $1
     i32.load16_u
     local.tee $4
     i32.ne
     if
      local.get $3
      local.get $4
      i32.sub
      br $__inlined_func$~lib/util/string/compareImpl$10
     end
     local.get $2
     i32.const 2
     i32.add
     local.set $2
     local.get $1
     i32.const 2
     i32.add
     local.set $1
     br $while-continue|1
    end
   end
   i32.const 0
  end
  i32.eqz
 )
 (func $~lib/rt/stub/maybeGrowMemory (param $0 i32)
  (local $1 i32)
  (local $2 i32)
  memory.size
  local.tee $1
  i32.const 16
  i32.shl
  i32.const 15
  i32.add
  i32.const -16
  i32.and
  local.tee $2
  local.get $0
  i32.lt_u
  if
   local.get $1
   local.get $0
   local.get $2
   i32.sub
   i32.const 65535
   i32.add
   i32.const -65536
   i32.and
   i32.const 16
   i32.shr_u
   local.tee $2
   local.get $1
   local.get $2
   i32.gt_s
   select
   memory.grow
   i32.const 0
   i32.lt_s
   if
    local.get $2
    memory.grow
    i32.const 0
    i32.lt_s
    if
     unreachable
    end
   end
  end
  local.get $0
  global.set $~lib/rt/stub/offset
 )
 (func $~lib/rt/stub/__renew (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  local.get $1
  i32.const 1073741804
  i32.gt_u
  if
   unreachable
  end
  local.get $0
  i32.const 16
  i32.sub
  local.tee $0
  i32.const 4
  i32.sub
  local.tee $4
  i32.load
  local.set $3
  global.get $~lib/rt/stub/offset
  local.get $0
  local.get $3
  i32.add
  i32.eq
  local.set $6
  local.get $1
  i32.const 16
  i32.add
  local.tee $2
  i32.const 19
  i32.add
  i32.const -16
  i32.and
  i32.const 4
  i32.sub
  local.set $5
  local.get $2
  local.get $3
  i32.gt_u
  if
   local.get $6
   if
    local.get $2
    i32.const 1073741820
    i32.gt_u
    if
     unreachable
    end
    local.get $0
    local.get $5
    i32.add
    call $~lib/rt/stub/maybeGrowMemory
    local.get $4
    local.get $5
    i32.store
   else
    local.get $5
    local.get $3
    i32.const 1
    i32.shl
    local.tee $2
    local.get $2
    local.get $5
    i32.lt_u
    select
    call $~lib/rt/stub/__alloc
    local.tee $2
    local.get $0
    local.get $3
    memory.copy
    local.get $2
    local.set $0
   end
  else
   local.get $6
   if
    local.get $0
    local.get $5
    i32.add
    global.set $~lib/rt/stub/offset
    local.get $4
    local.get $5
    i32.store
   end
  end
  local.get $0
  i32.const 4
  i32.sub
  local.get $1
  i32.store offset=16
  local.get $0
  i32.const 16
  i32.add
 )
 (func $~lib/math/ipow32 (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  i32.const 5
  local.set $1
  i32.const 1
  local.set $2
  loop $while-continue|0
   local.get $0
   if
    local.get $1
    local.get $2
    i32.mul
    local.get $2
    local.get $0
    i32.const 1
    i32.and
    select
    local.set $2
    local.get $0
    i32.const 1
    i32.shr_u
    local.set $0
    local.get $1
    local.get $1
    i32.mul
    local.set $1
    br $while-continue|0
   end
  end
  local.get $2
 )
 (func $~lib/math/NativeMath.scalbn (param $0 f64) (param $1 i32) (result f64)
  local.get $1
  i32.const 1023
  i32.gt_s
  if (result f64)
   local.get $0
   f64.const 8988465674311579538646525e283
   f64.mul
   local.set $0
   local.get $1
   i32.const 1023
   i32.sub
   local.tee $1
   i32.const 1023
   i32.gt_s
   if (result f64)
    i32.const 1023
    local.get $1
    i32.const 1023
    i32.sub
    local.tee $1
    local.get $1
    i32.const 1023
    i32.ge_s
    select
    local.set $1
    local.get $0
    f64.const 8988465674311579538646525e283
    f64.mul
   else
    local.get $0
   end
  else
   local.get $1
   i32.const -1022
   i32.lt_s
   if (result f64)
    local.get $0
    f64.const 2.004168360008973e-292
    f64.mul
    local.set $0
    local.get $1
    i32.const 969
    i32.add
    local.tee $1
    i32.const -1022
    i32.lt_s
    if (result f64)
     i32.const -1022
     local.get $1
     i32.const 969
     i32.add
     local.tee $1
     local.get $1
     i32.const -1022
     i32.le_s
     select
     local.set $1
     local.get $0
     f64.const 2.004168360008973e-292
     f64.mul
    else
     local.get $0
    end
   else
    local.get $0
   end
  end
  local.get $1
  i64.extend_i32_s
  i64.const 1023
  i64.add
  i64.const 52
  i64.shl
  f64.reinterpret_i64
  f64.mul
 )
 (func $assembly/index/Writer.quote (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  i32.const 1824
  local.set $3
  loop $for-loop|0
   local.get $5
   local.get $0
   i32.const 20
   i32.sub
   i32.load offset=16
   i32.const 1
   i32.shr_u
   i32.lt_s
   if
    local.get $0
    local.get $5
    call $~lib/string/String#charCodeAt
    local.tee $1
    i32.const 34
    i32.eq
    if (result i32)
     local.get $3
     i32.const 1856
     call $~lib/string/String.__concat
    else
     local.get $1
     i32.const 92
     i32.eq
     if (result i32)
      local.get $3
      i32.const 1888
      call $~lib/string/String.__concat
     else
      local.get $1
      i32.const 10
      i32.eq
      if (result i32)
       local.get $3
       i32.const 1920
       call $~lib/string/String.__concat
      else
       local.get $1
       i32.const 13
       i32.eq
       if (result i32)
        local.get $3
        i32.const 1952
        call $~lib/string/String.__concat
       else
        local.get $1
        i32.const 9
        i32.eq
        if (result i32)
         local.get $3
         i32.const 1984
         call $~lib/string/String.__concat
        else
         local.get $1
         i32.const 32
         i32.lt_s
         if (result i32)
          i32.const 2080
          local.set $2
          local.get $1
          if
           i32.const 31
           i32.const 0
           local.get $1
           i32.sub
           local.get $1
           local.get $1
           i32.const 31
           i32.shr_u
           i32.const 1
           i32.shl
           local.tee $7
           select
           local.tee $1
           i32.clz
           i32.sub
           i32.const 2
           i32.shr_s
           i32.const 1
           i32.add
           local.tee $4
           i32.const 1
           i32.shl
           local.get $7
           i32.add
           i32.const 2
           call $~lib/rt/stub/__new
           local.tee $2
           local.get $7
           i32.add
           local.set $8
           loop $do-loop|0
            local.get $8
            local.get $4
            i32.const 1
            i32.sub
            local.tee $4
            i32.const 1
            i32.shl
            i32.add
            i32.const 39
            i32.const 0
            local.get $1
            i32.const 15
            i32.and
            i32.const 48
            i32.or
            local.tee $6
            i32.const 57
            i32.gt_u
            select
            local.get $6
            i32.add
            i32.store16
            local.get $1
            i32.const 4
            i32.shr_u
            local.tee $1
            br_if $do-loop|0
           end
           local.get $7
           if
            local.get $2
            i32.const 45
            i32.store16
           end
          end
          i32.const 2048
          local.get $2
          call $~lib/string/String.__concat
          local.set $2
          i32.const 1
          global.set $~argumentsLength
          local.get $2
          i32.const 20
          i32.sub
          i32.load offset=16
          i32.const 1
          i32.shr_u
          local.tee $4
          i32.const 4
          i32.sub
          local.tee $1
          i32.const 0
          local.get $1
          i32.const 0
          i32.gt_s
          select
          local.set $6
          i32.const 1056
          local.set $1
          local.get $4
          local.get $6
          i32.sub
          local.tee $4
          i32.const 0
          i32.gt_s
          if
           local.get $4
           i32.const 1
           i32.shl
           local.tee $4
           i32.const 2
           call $~lib/rt/stub/__new
           local.tee $1
           local.get $2
           local.get $6
           i32.const 1
           i32.shl
           i32.add
           local.get $4
           memory.copy
          end
          local.get $3
          i32.const 2016
          local.get $1
          call $~lib/string/String.__concat
          call $~lib/string/String.__concat
         else
          i32.const 1
          global.set $~argumentsLength
          local.get $3
          local.get $1
          call $~lib/string/String.fromCharCode@varargs
          call $~lib/string/String.__concat
         end
        end
       end
      end
     end
    end
    local.set $3
    local.get $5
    i32.const 1
    i32.add
    local.set $5
    br $for-loop|0
   end
  end
  local.get $3
  i32.const 1824
  call $~lib/string/String.__concat
 )
 (func $assembly/index/Writer#string (param $0 i32) (param $1 i32)
  local.get $0
  call $assembly/index/Writer#separator
  local.get $0
  local.get $0
  i32.load
  local.get $1
  call $assembly/index/Writer.quote
  call $~lib/string/String.__concat
  i32.store
 )
 (func $assembly/index/Writer#endObject (param $0 i32)
  local.get $0
  local.get $0
  i32.load
  i32.const 2480
  call $~lib/string/String.__concat
  i32.store
  local.get $0
  i32.const 1
  i32.store8 offset=4
 )
 (func $assembly/index/Writer#beginObject (param $0 i32)
  local.get $0
  call $assembly/index/Writer#separator
  local.get $0
  local.get $0
  i32.load
  i32.const 1792
  call $~lib/string/String.__concat
  i32.store
  local.get $0
  i32.const 0
  i32.store8 offset=4
 )
 (func $assembly/index/Parser#string (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  call $assembly/index/Parser#next
  i32.const 34
  i32.ne
  if
   unreachable
  end
  i32.const 1056
  local.set $1
  loop $while-continue|0
   local.get $0
   call $assembly/index/Parser#next
   local.tee $2
   i32.const 34
   i32.eq
   if
    local.get $1
    return
   end
   local.get $2
   i32.const 32
   i32.lt_s
   if
    unreachable
   else
    local.get $2
    i32.const 92
    i32.ne
    if (result i32)
     i32.const 1
     global.set $~argumentsLength
     local.get $1
     local.get $2
     call $~lib/string/String.fromCharCode@varargs
     call $~lib/string/String.__concat
    else
     local.get $0
     call $assembly/index/Parser#next
     local.tee $2
     i32.const 92
     i32.eq
     local.get $2
     i32.const 34
     i32.eq
     i32.or
     local.get $2
     i32.const 47
     i32.eq
     i32.or
     if (result i32)
      i32.const 1
      global.set $~argumentsLength
      local.get $1
      local.get $2
      call $~lib/string/String.fromCharCode@varargs
      call $~lib/string/String.__concat
     else
      local.get $2
      i32.const 98
      i32.eq
      if (result i32)
       local.get $1
       i32.const 1184
       call $~lib/string/String.__concat
      else
       local.get $2
       i32.const 102
       i32.eq
       if (result i32)
        local.get $1
        i32.const 1216
        call $~lib/string/String.__concat
       else
        local.get $2
        i32.const 110
        i32.eq
        if (result i32)
         local.get $1
         i32.const 1248
         call $~lib/string/String.__concat
        else
         local.get $2
         i32.const 114
         i32.eq
         if (result i32)
          local.get $1
          i32.const 1280
          call $~lib/string/String.__concat
         else
          local.get $2
          i32.const 116
          i32.eq
          if (result i32)
           local.get $1
           i32.const 1312
           call $~lib/string/String.__concat
          else
           local.get $2
           i32.const 117
           i32.eq
           if (result i32)
            i32.const 0
            local.set $2
            i32.const 0
            local.set $3
            loop $for-loop|0
             local.get $3
             i32.const 4
             i32.lt_s
             if
              local.get $0
              call $assembly/index/Parser#next
              local.tee $4
              i32.const 57
              i32.le_s
              local.get $4
              i32.const 48
              i32.ge_s
              i32.and
              if (result i32)
               local.get $4
               i32.const 48
               i32.sub
              else
               local.get $4
               i32.const 102
               i32.le_s
               local.get $4
               i32.const 97
               i32.ge_s
               i32.and
               if (result i32)
                local.get $4
                i32.const 87
                i32.sub
               else
                local.get $4
                i32.const 70
                i32.le_s
                local.get $4
                i32.const 65
                i32.ge_s
                i32.and
                if (result i32)
                 local.get $4
                 i32.const 55
                 i32.sub
                else
                 unreachable
                end
               end
              end
              local.get $2
              i32.const 4
              i32.shl
              i32.add
              local.set $2
              local.get $3
              i32.const 1
              i32.add
              local.set $3
              br $for-loop|0
             end
            end
            i32.const 1
            global.set $~argumentsLength
            local.get $1
            local.get $2
            call $~lib/string/String.fromCharCode@varargs
            call $~lib/string/String.__concat
           else
            unreachable
           end
          end
         end
        end
       end
      end
     end
    end
    local.set $1
    br $while-continue|0
   end
   unreachable
  end
  unreachable
 )
 (func $assembly/index/Json#asString (param $0 i32) (result i32)
  local.get $0
  i32.load
  i32.const 3
  i32.ne
  if
   unreachable
  end
  local.get $0
  i32.load offset=32
 )
 (func $~start
  i32.const 2620
  global.set $~lib/rt/stub/offset
 )
 (func $~lib/util/string/strtod (param $0 i32) (result f64)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i64)
  (local $6 i32)
  (local $7 i64)
  (local $8 f64)
  (local $9 f64)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i64)
  (local $14 i64)
  (local $15 i64)
  block $folding-inner0
   local.get $0
   i32.const 20
   i32.sub
   i32.load offset=16
   i32.const 1
   i32.shr_u
   local.tee $6
   i32.eqz
   br_if $folding-inner0
   local.get $0
   i32.load16_u
   local.set $4
   f64.const 1
   local.set $9
   loop $while-continue|0
    local.get $6
    if (result i32)
     block $__inlined_func$~lib/util/string/isSpace$68 (result i32)
      local.get $4
      i32.const 128
      i32.or
      i32.const 160
      i32.eq
      local.get $4
      i32.const 9
      i32.sub
      i32.const 4
      i32.le_u
      i32.or
      local.get $4
      i32.const 5760
      i32.lt_u
      br_if $__inlined_func$~lib/util/string/isSpace$68
      drop
      i32.const 1
      local.get $4
      i32.const -8192
      i32.add
      i32.const 10
      i32.le_u
      br_if $__inlined_func$~lib/util/string/isSpace$68
      drop
      i32.const 1
      local.get $4
      i32.const 5760
      i32.eq
      local.get $4
      i32.const 8232
      i32.eq
      i32.or
      local.get $4
      i32.const 8233
      i32.eq
      local.get $4
      i32.const 8239
      i32.eq
      i32.or
      i32.or
      local.get $4
      i32.const 8287
      i32.eq
      local.get $4
      i32.const 12288
      i32.eq
      i32.or
      local.get $4
      i32.const 65279
      i32.eq
      i32.or
      i32.or
      br_if $__inlined_func$~lib/util/string/isSpace$68
      drop
      i32.const 0
     end
    else
     i32.const 0
    end
    if
     local.get $0
     i32.const 2
     i32.add
     local.tee $0
     i32.load16_u
     local.set $4
     local.get $6
     i32.const 1
     i32.sub
     local.set $6
     br $while-continue|0
    end
   end
   local.get $6
   i32.eqz
   br_if $folding-inner0
   local.get $4
   i32.const 45
   i32.eq
   if (result i32)
    local.get $6
    i32.const 1
    i32.sub
    local.tee $6
    i32.eqz
    br_if $folding-inner0
    f64.const -1
    local.set $9
    local.get $0
    i32.const 2
    i32.add
    local.tee $0
    i32.load16_u
   else
    local.get $4
    i32.const 43
    i32.eq
    if (result i32)
     local.get $6
     i32.const 1
     i32.sub
     local.tee $6
     i32.eqz
     br_if $folding-inner0
     local.get $0
     i32.const 2
     i32.add
     local.tee $0
     i32.load16_u
    else
     local.get $4
    end
   end
   local.tee $4
   i32.const 73
   i32.eq
   local.get $6
   i32.const 8
   i32.ge_s
   i32.and
   if
    local.get $0
    i64.load
    i64.const 29555310648492105
    i64.eq
    if (result i32)
     local.get $0
     i64.load offset=8
     i64.const 34058970405077102
     i64.eq
    else
     i32.const 0
    end
    if
     local.get $9
     f64.const inf
     f64.mul
     return
    end
    br $folding-inner0
   end
   local.get $4
   i32.const 46
   i32.ne
   local.get $4
   i32.const 48
   i32.sub
   i32.const 10
   i32.ge_u
   i32.and
   br_if $folding-inner0
   local.get $0
   local.set $3
   loop $while-continue|1
    local.get $4
    i32.const 48
    i32.eq
    if
     local.get $0
     i32.const 2
     i32.add
     local.tee $0
     i32.load16_u
     local.set $4
     local.get $6
     i32.const 1
     i32.sub
     local.set $6
     br $while-continue|1
    end
   end
   local.get $6
   i32.const 0
   i32.le_s
   if
    local.get $9
    f64.const 0
    f64.mul
    return
   end
   local.get $4
   i32.const 46
   i32.eq
   if
    local.get $0
    local.get $3
    i32.eq
    local.set $3
    local.get $0
    i32.const 2
    i32.add
    local.set $0
    local.get $3
    local.get $6
    i32.const 1
    i32.sub
    local.tee $6
    i32.eqz
    i32.and
    br_if $folding-inner0
    i32.const 1
    local.set $10
    loop $for-loop|2
     local.get $0
     i32.load16_u
     local.tee $4
     i32.const 48
     i32.eq
     if
      local.get $6
      i32.const 1
      i32.sub
      local.set $6
      local.get $2
      i32.const 1
      i32.sub
      local.set $2
      local.get $0
      i32.const 2
      i32.add
      local.set $0
      br $for-loop|2
     end
    end
    local.get $6
    i32.const 0
    i32.le_s
    if
     local.get $9
     f64.const 0
     f64.mul
     return
    end
    local.get $3
    local.get $2
    i32.eqz
    i32.and
    local.get $4
    i32.const 48
    i32.sub
    i32.const 10
    i32.ge_u
    i32.and
    br_if $folding-inner0
   end
   local.get $4
   i32.const 48
   i32.sub
   local.set $3
   loop $for-loop|3
    local.get $3
    i32.const 10
    i32.lt_u
    local.tee $12
    local.get $10
    i32.eqz
    local.get $4
    i32.const 46
    i32.eq
    i32.and
    i32.or
    if
     block $for-break3
      local.get $12
      if
       local.get $3
       i64.extend_i32_u
       local.get $5
       i64.const 10
       i64.mul
       i64.add
       local.get $5
       local.get $3
       i32.eqz
       i32.eqz
       i64.extend_i32_u
       i64.or
       local.get $1
       i32.const 19
       i32.lt_s
       select
       local.set $5
       local.get $1
       i32.const 1
       i32.add
       local.set $1
      else
       local.get $1
       local.set $2
       i32.const 1
       local.set $10
      end
      local.get $6
      i32.const 1
      i32.sub
      local.tee $6
      i32.eqz
      br_if $for-break3
      local.get $0
      i32.const 2
      i32.add
      local.tee $0
      i32.load16_u
      local.tee $4
      i32.const 48
      i32.sub
      local.set $3
      br $for-loop|3
     end
    end
   end
   local.get $2
   local.get $1
   local.get $10
   select
   i32.const 19
   local.get $1
   local.get $1
   i32.const 19
   i32.gt_s
   select
   i32.sub
   local.set $10
   i32.const 1
   local.set $3
   block $~lib/util/string/scientific|inlined.0
    local.get $5
    i64.eqz
    block $~lib/util/string/parseExp|inlined.0 (result i32)
     i32.const 0
     local.get $0
     i32.load16_u
     i32.const 32
     i32.or
     i32.const 101
     i32.ne
     br_if $~lib/util/string/parseExp|inlined.0
     drop
     i32.const 0
     local.get $6
     i32.const 1
     i32.sub
     local.tee $1
     i32.eqz
     br_if $~lib/util/string/parseExp|inlined.0
     drop
     local.get $0
     i32.const 2
     i32.add
     local.tee $0
     i32.load16_u
     local.tee $2
     i32.const 45
     i32.eq
     if (result i32)
      i32.const 0
      local.get $1
      i32.const 1
      i32.sub
      local.tee $1
      i32.eqz
      br_if $~lib/util/string/parseExp|inlined.0
      drop
      i32.const -1
      local.set $3
      local.get $0
      i32.const 2
      i32.add
      local.tee $0
      i32.load16_u
     else
      local.get $2
      i32.const 43
      i32.eq
      if (result i32)
       i32.const 0
       local.get $1
       i32.const 1
       i32.sub
       local.tee $1
       i32.eqz
       br_if $~lib/util/string/parseExp|inlined.0
       drop
       local.get $0
       i32.const 2
       i32.add
       local.tee $0
       i32.load16_u
      else
       local.get $2
      end
     end
     local.set $2
     loop $while-continue|4
      local.get $2
      i32.const 48
      i32.eq
      if
       i32.const 0
       local.get $1
       i32.const 1
       i32.sub
       local.tee $1
       i32.eqz
       br_if $~lib/util/string/parseExp|inlined.0
       drop
       local.get $0
       i32.const 2
       i32.add
       local.tee $0
       i32.load16_u
       local.set $2
       br $while-continue|4
      end
     end
     local.get $2
     i32.const 48
     i32.sub
     local.set $4
     loop $for-loop|5
      local.get $4
      i32.const 10
      i32.lt_u
      i32.const 0
      local.get $1
      select
      if
       local.get $3
       i32.const 3200
       i32.mul
       local.get $11
       i32.const 3200
       i32.ge_s
       br_if $~lib/util/string/parseExp|inlined.0
       drop
       local.get $11
       i32.const 10
       i32.mul
       local.get $4
       i32.add
       local.set $11
       local.get $1
       i32.const 1
       i32.sub
       local.set $1
       local.get $0
       i32.const 2
       i32.add
       local.tee $0
       i32.load16_u
       i32.const 48
       i32.sub
       local.set $4
       br $for-loop|5
      end
     end
     local.get $3
     local.get $11
     i32.mul
    end
    local.get $10
    i32.add
    local.tee $0
    i32.const -342
    i32.lt_s
    i32.or
    br_if $~lib/util/string/scientific|inlined.0
    f64.const inf
    local.set $8
    local.get $0
    i32.const 308
    i32.gt_s
    br_if $~lib/util/string/scientific|inlined.0
    local.get $5
    f64.convert_i64_u
    local.set $8
    local.get $0
    i32.eqz
    br_if $~lib/util/string/scientific|inlined.0
    local.get $0
    i32.const 37
    i32.le_s
    local.get $0
    i32.const 22
    i32.gt_s
    i32.and
    if
     local.get $8
     local.get $0
     i32.const 3
     i32.shl
     i32.const 1248
     i32.add
     f64.load
     f64.mul
     local.set $8
     i32.const 22
     local.set $0
    end
    local.get $5
    i64.const 9007199254740991
    i64.le_u
    if (result i32)
     local.get $0
     i32.const 31
     i32.shr_s
     local.tee $1
     local.get $0
     local.get $1
     i32.add
     i32.xor
     i32.const 22
     i32.le_s
    else
     i32.const 0
    end
    if (result f64)
     local.get $0
     i32.const 0
     i32.gt_s
     if
      local.get $8
      local.get $0
      i32.const 3
      i32.shl
      i32.const 1424
      i32.add
      f64.load
      f64.mul
      local.set $8
      br $~lib/util/string/scientific|inlined.0
     end
     local.get $8
     i32.const 0
     local.get $0
     i32.sub
     i32.const 3
     i32.shl
     i32.const 1424
     i32.add
     f64.load
     f64.div
    else
     local.get $0
     i32.const 0
     i32.lt_s
     if (result f64)
      local.get $5
      local.get $5
      i64.clz
      local.tee $7
      i64.shl
      local.set $5
      local.get $0
      i64.extend_i32_s
      local.get $7
      i64.sub
      local.set $7
      loop $for-loop|6
       local.get $0
       i32.const -14
       i32.le_s
       if
        local.get $5
        i64.const 6103515625
        i64.rem_u
        local.get $5
        i64.const 6103515625
        i64.div_u
        local.tee $5
        i64.clz
        local.tee $13
        i64.const 18
        i64.sub
        i64.shl
        f64.convert_i64_u
        f64.const 0.00004294967296
        f64.mul
        f64.nearest
        i64.trunc_sat_f64_u
        local.get $5
        local.get $13
        i64.shl
        i64.add
        local.set $5
        local.get $7
        local.get $13
        i64.sub
        local.set $7
        local.get $0
        i32.const 14
        i32.add
        local.set $0
        br $for-loop|6
       end
      end
      local.get $5
      i32.const 0
      local.get $0
      i32.sub
      call $~lib/math/ipow32
      i64.extend_i32_s
      local.tee $13
      i64.div_u
      local.tee $15
      i64.clz
      local.set $14
      local.get $5
      local.get $13
      i64.rem_u
      f64.convert_i64_u
      i64.reinterpret_f64
      local.get $14
      i64.const 52
      i64.shl
      i64.add
      f64.reinterpret_i64
      local.get $13
      f64.convert_i64_u
      f64.div
      i64.trunc_sat_f64_u
      local.get $15
      local.get $14
      i64.shl
      i64.add
      f64.convert_i64_u
      local.get $7
      local.get $14
      i64.sub
      i32.wrap_i64
      call $~lib/math/NativeMath.scalbn
     else
      local.get $5
      local.get $5
      i64.ctz
      local.tee $7
      i64.shr_u
      local.set $5
      local.get $7
      local.get $0
      i64.extend_i32_s
      i64.add
      global.set $~lib/util/string/__fixmulShift
      loop $for-loop|7
       local.get $0
       i32.const 13
       i32.ge_s
       if
        i64.const 32
        local.get $5
        i64.const 32
        i64.shr_u
        i64.const 1220703125
        i64.mul
        local.get $5
        i64.const 4294967295
        i64.and
        i64.const 1220703125
        i64.mul
        local.tee $5
        i64.const 32
        i64.shr_u
        i64.add
        local.tee $7
        i64.const 32
        i64.shr_u
        i32.wrap_i64
        i32.clz
        local.tee $1
        i64.extend_i32_u
        i64.sub
        local.tee $13
        global.get $~lib/util/string/__fixmulShift
        i64.add
        global.set $~lib/util/string/__fixmulShift
        local.get $5
        local.get $1
        i64.extend_i32_u
        i64.shl
        i64.const 31
        i64.shr_u
        i64.const 1
        i64.and
        local.get $7
        local.get $1
        i64.extend_i32_u
        i64.shl
        local.get $5
        i64.const 4294967295
        i64.and
        local.get $13
        i64.shr_u
        i64.or
        i64.add
        local.set $5
        local.get $0
        i32.const 13
        i32.sub
        local.set $0
        br $for-loop|7
       end
      end
      local.get $0
      call $~lib/math/ipow32
      local.tee $0
      i64.extend_i32_u
      local.get $5
      i64.const 4294967295
      i64.and
      i64.mul
      local.set $7
      i64.const 32
      local.get $0
      i64.extend_i32_u
      local.get $5
      i64.const 32
      i64.shr_u
      i64.mul
      local.get $7
      i64.const 32
      i64.shr_u
      i64.add
      local.tee $5
      i64.const 32
      i64.shr_u
      i32.wrap_i64
      i32.clz
      local.tee $0
      i64.extend_i32_u
      i64.sub
      local.tee $13
      global.get $~lib/util/string/__fixmulShift
      i64.add
      global.set $~lib/util/string/__fixmulShift
      local.get $7
      local.get $0
      i64.extend_i32_u
      i64.shl
      i64.const 31
      i64.shr_u
      i64.const 1
      i64.and
      local.get $5
      local.get $0
      i64.extend_i32_u
      i64.shl
      local.get $7
      i64.const 4294967295
      i64.and
      local.get $13
      i64.shr_u
      i64.or
      i64.add
      f64.convert_i64_u
      global.get $~lib/util/string/__fixmulShift
      i32.wrap_i64
      call $~lib/math/NativeMath.scalbn
     end
    end
    local.set $8
   end
   local.get $8
   local.get $9
   f64.copysign
   return
  end
  f64.const nan:0x8000000000000
 )
 (func $~lib/util/number/itoa64 (param $0 i64) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  local.get $0
  i64.eqz
  if
   i32.const 2080
   return
  end
  i64.const 0
  local.get $0
  i64.sub
  local.get $0
  local.get $0
  i64.const 63
  i64.shr_u
  i32.wrap_i64
  i32.const 1
  i32.shl
  local.tee $2
  select
  local.tee $0
  i64.const 4294967295
  i64.le_u
  if
   local.get $0
   i32.wrap_i64
   local.tee $1
   i32.const 100000
   i32.lt_u
   if (result i32)
    local.get $1
    i32.const 10
    i32.ge_u
    i32.const 1
    i32.add
    local.get $1
    i32.const 10000
    i32.ge_u
    i32.const 3
    i32.add
    local.get $1
    i32.const 1000
    i32.ge_u
    i32.add
    local.get $1
    i32.const 100
    i32.lt_u
    select
   else
    local.get $1
    i32.const 1000000
    i32.ge_u
    i32.const 6
    i32.add
    local.get $1
    i32.const 1000000000
    i32.ge_u
    i32.const 8
    i32.add
    local.get $1
    i32.const 100000000
    i32.ge_u
    i32.add
    local.get $1
    i32.const 10000000
    i32.lt_u
    select
   end
   local.tee $3
   i32.const 1
   i32.shl
   local.get $2
   i32.add
   i32.const 2
   call $~lib/rt/stub/__new
   local.tee $4
   local.get $2
   i32.add
   local.set $5
   loop $do-loop|0
    local.get $5
    local.get $3
    i32.const 1
    i32.sub
    local.tee $3
    i32.const 1
    i32.shl
    i32.add
    local.get $1
    i32.const 10
    i32.rem_u
    i32.const 48
    i32.add
    i32.store16
    local.get $1
    i32.const 10
    i32.div_u
    local.tee $1
    br_if $do-loop|0
   end
  else
   local.get $0
   i64.const 1000000000000000
   i64.lt_u
   if (result i32)
    local.get $0
    i64.const 100000000000
    i64.ge_u
    i32.const 10
    i32.add
    local.get $0
    i64.const 10000000000
    i64.ge_u
    i32.add
    local.get $0
    i64.const 100000000000000
    i64.ge_u
    i32.const 13
    i32.add
    local.get $0
    i64.const 10000000000000
    i64.ge_u
    i32.add
    local.get $0
    i64.const 1000000000000
    i64.lt_u
    select
   else
    local.get $0
    i64.const 10000000000000000
    i64.ge_u
    i32.const 16
    i32.add
    local.get $0
    i64.const -8446744073709551616
    i64.ge_u
    i32.const 18
    i32.add
    local.get $0
    i64.const 1000000000000000000
    i64.ge_u
    i32.add
    local.get $0
    i64.const 100000000000000000
    i64.lt_u
    select
   end
   local.tee $1
   i32.const 1
   i32.shl
   local.get $2
   i32.add
   i32.const 2
   call $~lib/rt/stub/__new
   local.tee $4
   local.get $2
   i32.add
   local.set $3
   loop $do-loop|00
    local.get $3
    local.get $1
    i32.const 1
    i32.sub
    local.tee $1
    i32.const 1
    i32.shl
    i32.add
    local.get $0
    i64.const 10
    i64.rem_u
    i32.wrap_i64
    i32.const 48
    i32.add
    i32.store16
    local.get $0
    i64.const 10
    i64.div_u
    local.tee $0
    i64.const 0
    i64.ne
    br_if $do-loop|00
   end
  end
  local.get $2
  if
   local.get $4
   i32.const 45
   i32.store16
  end
  local.get $4
 )
 (func $~lib/string/String.UTF8.encodeUnsafe (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  local.get $1
  i32.const 1
  i32.shl
  i32.add
  local.set $3
  local.get $2
  local.set $1
  loop $while-continue|0
   local.get $0
   local.get $3
   i32.lt_u
   if
    local.get $0
    i32.load16_u
    local.tee $2
    i32.const 128
    i32.lt_u
    if (result i32)
     local.get $1
     local.get $2
     i32.store8
     local.get $1
     i32.const 1
     i32.add
    else
     local.get $2
     i32.const 2048
     i32.lt_u
     if (result i32)
      local.get $1
      local.get $2
      i32.const 6
      i32.shr_u
      i32.const 192
      i32.or
      local.get $2
      i32.const 63
      i32.and
      i32.const 128
      i32.or
      i32.const 8
      i32.shl
      i32.or
      i32.store16
      local.get $1
      i32.const 2
      i32.add
     else
      local.get $2
      i32.const 56320
      i32.lt_u
      local.get $0
      i32.const 2
      i32.add
      local.get $3
      i32.lt_u
      i32.and
      local.get $2
      i32.const 63488
      i32.and
      i32.const 55296
      i32.eq
      i32.and
      if
       local.get $0
       i32.load16_u offset=2
       local.tee $4
       i32.const 64512
       i32.and
       i32.const 56320
       i32.eq
       if
        local.get $1
        local.get $2
        i32.const 1023
        i32.and
        i32.const 10
        i32.shl
        i32.const 65536
        i32.add
        local.get $4
        i32.const 1023
        i32.and
        i32.or
        local.tee $2
        i32.const 63
        i32.and
        i32.const 128
        i32.or
        i32.const 24
        i32.shl
        local.get $2
        i32.const 6
        i32.shr_u
        i32.const 63
        i32.and
        i32.const 128
        i32.or
        i32.const 16
        i32.shl
        i32.or
        local.get $2
        i32.const 12
        i32.shr_u
        i32.const 63
        i32.and
        i32.const 128
        i32.or
        i32.const 8
        i32.shl
        i32.or
        local.get $2
        i32.const 18
        i32.shr_u
        i32.const 240
        i32.or
        i32.or
        i32.store
        local.get $1
        i32.const 4
        i32.add
        local.set $1
        local.get $0
        i32.const 4
        i32.add
        local.set $0
        br $while-continue|0
       end
      end
      local.get $1
      local.get $2
      i32.const 12
      i32.shr_u
      i32.const 224
      i32.or
      local.get $2
      i32.const 6
      i32.shr_u
      i32.const 63
      i32.and
      i32.const 128
      i32.or
      i32.const 8
      i32.shl
      i32.or
      i32.store16
      local.get $1
      local.get $2
      i32.const 63
      i32.and
      i32.const 128
      i32.or
      i32.store8 offset=2
      local.get $1
      i32.const 3
      i32.add
     end
    end
    local.set $1
    local.get $0
    i32.const 2
    i32.add
    local.set $0
    br $while-continue|0
   end
  end
 )
 (func $~lib/string/String.UTF8.decodeUnsafe (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  local.get $0
  local.get $1
  i32.add
  local.set $3
  local.get $1
  i32.const 1
  i32.shl
  i32.const 2
  call $~lib/rt/stub/__new
  local.tee $4
  local.set $1
  loop $while-continue|0
   local.get $0
   local.get $3
   i32.lt_u
   if
    block $while-break|0
     local.get $0
     i32.load8_u
     local.set $5
     local.get $0
     i32.const 1
     i32.add
     local.set $0
     local.get $5
     i32.const 128
     i32.and
     if
      local.get $0
      local.get $3
      i32.eq
      br_if $while-break|0
      local.get $0
      i32.load8_u
      i32.const 63
      i32.and
      local.set $6
      local.get $0
      i32.const 1
      i32.add
      local.set $0
      local.get $5
      i32.const 224
      i32.and
      i32.const 192
      i32.eq
      if
       local.get $1
       local.get $5
       i32.const 31
       i32.and
       i32.const 6
       i32.shl
       local.get $6
       i32.or
       i32.store16
      else
       local.get $0
       local.get $3
       i32.eq
       br_if $while-break|0
       local.get $0
       i32.load8_u
       i32.const 63
       i32.and
       local.set $2
       local.get $0
       i32.const 1
       i32.add
       local.set $0
       local.get $5
       i32.const 240
       i32.and
       i32.const 224
       i32.eq
       if
        local.get $5
        i32.const 15
        i32.and
        i32.const 12
        i32.shl
        local.get $6
        i32.const 6
        i32.shl
        i32.or
        local.get $2
        i32.or
        local.set $2
       else
        local.get $0
        local.get $3
        i32.eq
        br_if $while-break|0
        local.get $0
        i32.load8_u
        i32.const 63
        i32.and
        local.get $5
        i32.const 7
        i32.and
        i32.const 18
        i32.shl
        local.get $6
        i32.const 12
        i32.shl
        i32.or
        local.get $2
        i32.const 6
        i32.shl
        i32.or
        i32.or
        local.set $2
        local.get $0
        i32.const 1
        i32.add
        local.set $0
       end
       local.get $2
       i32.const 65536
       i32.lt_u
       if
        local.get $1
        local.get $2
        i32.store16
       else
        local.get $1
        local.get $2
        i32.const 65536
        i32.sub
        local.tee $2
        i32.const 10
        i32.shr_u
        i32.const 55296
        i32.or
        local.get $2
        i32.const 1023
        i32.and
        i32.const 56320
        i32.or
        i32.const 16
        i32.shl
        i32.or
        i32.store
        local.get $1
        i32.const 2
        i32.add
        local.set $1
       end
      end
     else
      local.get $1
      local.get $5
      i32.store16
     end
     local.get $1
     i32.const 2
     i32.add
     local.set $1
     br $while-continue|0
    end
   end
  end
  local.get $4
  local.get $1
  local.get $4
  i32.sub
  call $~lib/rt/stub/__renew
 )
 (func $assembly/index/run (param $0 i32) (param $1 i32) (result i64)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  local.get $1
  call $~lib/string/String.UTF8.decodeUnsafe
  local.set $0
  i32.const 8
  i32.const 7
  call $~lib/rt/stub/__new
  local.tee $1
  i32.const 0
  i32.store
  local.get $1
  i32.const 0
  i32.store offset=4
  local.get $1
  local.get $0
  i32.store
  local.get $1
  call $assembly/index/Parser#skipSpace
  local.get $1
  i32.const 0
  call $assembly/index/Parser#value
  local.get $1
  call $assembly/index/Parser#skipSpace
  local.get $1
  i32.load offset=4
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
  i32.ne
  if
   unreachable
  end
  call $assembly/index/fareTotals
  local.set $2
  i32.const 1
  global.set $~argumentsLength
  i32.const 0
  local.set $0
  local.get $2
  local.tee $1
  i32.const 20
  i32.sub
  i32.load offset=16
  local.get $1
  i32.add
  local.set $3
  loop $while-continue|0
   local.get $1
   local.get $3
   i32.lt_u
   if
    local.get $1
    i32.load16_u
    local.tee $4
    i32.const 128
    i32.lt_u
    if (result i32)
     local.get $0
     i32.const 1
     i32.add
    else
     local.get $4
     i32.const 2048
     i32.lt_u
     if (result i32)
      local.get $0
      i32.const 2
      i32.add
     else
      local.get $4
      i32.const 64512
      i32.and
      i32.const 55296
      i32.eq
      local.get $1
      i32.const 2
      i32.add
      local.get $3
      i32.lt_u
      i32.and
      if
       local.get $1
       i32.load16_u offset=2
       i32.const 64512
       i32.and
       i32.const 56320
       i32.eq
       if
        local.get $0
        i32.const 4
        i32.add
        local.set $0
        local.get $1
        i32.const 4
        i32.add
        local.set $1
        br $while-continue|0
       end
      end
      local.get $0
      i32.const 3
      i32.add
     end
    end
    local.set $0
    local.get $1
    i32.const 2
    i32.add
    local.set $1
    br $while-continue|0
   end
  end
  local.get $0
  i32.const 1
  call $~lib/rt/stub/__new
  local.set $0
  local.get $2
  local.get $2
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
  local.get $0
  call $~lib/string/String.UTF8.encodeUnsafe
  local.get $0
  i32.const 20
  i32.sub
  i64.load32_s offset=16
  local.get $0
  i64.extend_i32_u
  i64.const 32
  i64.shl
  i64.or
 )
 (func $assembly/index/fareTotals (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i64)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i64)
  (local $7 i64)
  (local $8 i64)
  (local $9 i32)
  (local $10 i64)
  local.get $0
  i32.const 1632
  call $assembly/index/Json#field
  call $assembly/index/Json#asString
  local.tee $4
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
  i32.const 3
  i32.lt_u
  if (result i32)
   i32.const 1
  else
   local.get $4
   i32.const 20
   i32.sub
   i32.load offset=16
   i32.const 1
   i32.shr_u
   i32.const 3
   i32.gt_u
  end
  if
   unreachable
  end
  local.get $0
  i32.const 1680
  call $assembly/index/Json#field
  call $assembly/index/Json#asInt
  local.tee $8
  i64.const 0
  i64.lt_s
  local.get $8
  i64.const 10000
  i64.gt_s
  i32.or
  if
   unreachable
  end
  local.get $0
  i32.const 1728
  call $assembly/index/Json#field
  local.tee $0
  i32.load
  i32.const 4
  i32.ne
  if
   unreachable
  end
  local.get $0
  i32.load offset=36
  local.tee $3
  i32.load offset=12
  if (result i32)
   local.get $3
   i32.load offset=12
   i32.const 64
   i32.gt_s
  else
   i32.const 1
  end
  if
   unreachable
  end
  i32.const 5
  i32.const 9
  call $~lib/rt/stub/__new
  local.tee $0
  i32.eqz
  if
   i32.const 0
   i32.const 0
   call $~lib/rt/stub/__new
   local.set $0
  end
  local.get $0
  i32.const 1056
  i32.store
  local.get $0
  i32.const 0
  i32.store8 offset=4
  local.get $0
  call $assembly/index/Writer#beginObject
  local.get $0
  i32.const 1632
  call $assembly/index/Writer#key
  local.get $4
  call $assembly/index/Writer#string
  local.get $0
  i32.const 2240
  call $assembly/index/Writer#key
  local.tee $4
  call $assembly/index/Writer#separator
  local.get $4
  local.get $4
  i32.load
  i32.const 2272
  call $~lib/string/String.__concat
  i32.store
  local.get $4
  i32.const 0
  i32.store8 offset=4
  loop $for-loop|0
   local.get $1
   local.get $3
   i32.load offset=12
   i32.lt_s
   if
    local.get $3
    local.get $1
    call $~lib/array/Array<~lib/string/String>#__get
    local.tee $9
    i32.const 2304
    call $assembly/index/Json#field
    call $assembly/index/Json#asString
    local.tee $4
    i32.const 20
    i32.sub
    i32.load offset=16
    i32.const 1
    i32.shr_u
    local.tee $5
    if (result i32)
     local.get $5
     i32.const 200
     i32.gt_u
    else
     i32.const 1
    end
    if
     unreachable
    end
    local.get $9
    i32.const 2336
    call $assembly/index/Json#field
    call $assembly/index/Json#asInt
    local.tee $6
    i64.const 0
    i64.lt_s
    local.get $6
    i64.const 9007199254740991
    i64.gt_s
    i32.or
    local.get $9
    i32.const 2384
    call $assembly/index/Json#field
    call $assembly/index/Json#asInt
    local.tee $7
    i64.const 0
    i64.le_s
    i32.or
    local.get $7
    i64.const 9
    i64.gt_s
    i32.or
    if
     unreachable
    end
    local.get $6
    local.get $7
    i64.mul
    local.tee $10
    i64.const 9007199254740991
    i64.gt_s
    if
     unreachable
    end
    local.get $2
    local.get $10
    i64.add
    local.tee $2
    i64.const 9007199254740991
    i64.gt_s
    if
     unreachable
    end
    local.get $0
    call $assembly/index/Writer#beginObject
    local.get $0
    i32.const 2304
    call $assembly/index/Writer#key
    local.get $4
    call $assembly/index/Writer#string
    local.get $0
    i32.const 2336
    call $assembly/index/Writer#key
    local.get $6
    call $assembly/index/Writer#integer
    local.get $0
    i32.const 2384
    call $assembly/index/Writer#key
    local.get $7
    call $assembly/index/Writer#integer
    local.get $0
    i32.const 2432
    call $assembly/index/Writer#key
    local.get $10
    call $assembly/index/Writer#integer
    local.get $0
    call $assembly/index/Writer#endObject
    local.get $1
    i32.const 1
    i32.add
    local.set $1
    br $for-loop|0
   end
  end
  local.get $0
  local.get $0
  i32.load
  i32.const 2512
  call $~lib/string/String.__concat
  i32.store
  local.get $0
  i32.const 1
  i32.store8 offset=4
  local.get $2
  local.get $8
  i64.mul
  i64.const 5000
  i64.add
  i64.const 10000
  i64.div_s
  local.tee $6
  local.get $2
  i64.add
  local.tee $7
  i64.const 9007199254740991
  i64.gt_s
  if
   unreachable
  end
  local.get $0
  i32.const 2544
  call $assembly/index/Writer#key
  local.get $2
  call $assembly/index/Writer#integer
  local.get $0
  i32.const 2592
  call $assembly/index/Writer#key
  local.get $6
  call $assembly/index/Writer#integer
  local.get $0
  i32.const 2432
  call $assembly/index/Writer#key
  local.get $7
  call $assembly/index/Writer#integer
  local.get $0
  call $assembly/index/Writer#endObject
  local.get $0
  i32.load
 )
 (func $assembly/index/alloc (param $0 i32) (result i32)
  local.get $0
  call $~lib/rt/stub/__alloc
 )
 (func $assembly/index/Parser#object (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  local.get $0
  call $assembly/index/Parser#next
  i32.const 123
  i32.ne
  if
   unreachable
  end
  i32.const 5
  call $assembly/index/Json#constructor
  local.set $2
  local.get $0
  call $assembly/index/Parser#skipSpace
  local.get $0
  call $assembly/index/Parser#peek
  i32.const 125
  i32.eq
  if
   local.get $0
   local.get $0
   i32.load offset=4
   i32.const 1
   i32.add
   i32.store offset=4
   local.get $2
   return
  end
  loop $while-continue|0
   local.get $0
   call $assembly/index/Parser#skipSpace
   local.get $0
   call $assembly/index/Parser#string
   local.set $4
   i32.const 0
   local.set $3
   loop $for-loop|1
    local.get $3
    local.get $2
    i32.load offset=40
    i32.load offset=12
    i32.lt_s
    if
     local.get $2
     i32.load offset=40
     local.get $3
     call $~lib/array/Array<~lib/string/String>#__get
     local.get $4
     call $~lib/string/String.__eq
     if
      unreachable
     end
     local.get $3
     i32.const 1
     i32.add
     local.set $3
     br $for-loop|1
    end
   end
   local.get $0
   call $assembly/index/Parser#skipSpace
   local.get $0
   call $assembly/index/Parser#next
   i32.const 58
   i32.ne
   if
    unreachable
   end
   local.get $0
   call $assembly/index/Parser#skipSpace
   local.get $2
   i32.load offset=40
   local.get $4
   call $~lib/array/Array<~lib/string/String>#push
   local.get $2
   i32.load offset=44
   local.get $0
   local.get $1
   i32.const 1
   i32.add
   call $assembly/index/Parser#value
   call $~lib/array/Array<~lib/string/String>#push
   local.get $0
   call $assembly/index/Parser#skipSpace
   local.get $0
   call $assembly/index/Parser#next
   local.tee $3
   i32.const 125
   i32.eq
   if
    local.get $2
    return
   end
   local.get $3
   i32.const 44
   i32.eq
   br_if $while-continue|0
  end
  unreachable
 )
 (func $assembly/index/Parser#number (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i64)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  local.get $0
  i32.load offset=4
  local.set $1
  local.get $0
  call $assembly/index/Parser#peek
  i32.const 45
  i32.eq
  if (result i32)
   local.get $0
   local.get $0
   i32.load offset=4
   i32.const 1
   i32.add
   i32.store offset=4
   i32.const 1
  else
   i32.const 0
  end
  local.set $4
  local.get $0
  call $assembly/index/Parser#peek
  local.tee $5
  i32.const 48
  i32.eq
  if
   local.get $0
   local.get $0
   i32.load offset=4
   i32.const 1
   i32.add
   i32.store offset=4
   local.get $0
   call $assembly/index/Parser#peek
   i32.const 48
   i32.ge_s
   if (result i32)
    local.get $0
    call $assembly/index/Parser#peek
    i32.const 57
    i32.le_s
   else
    i32.const 0
   end
   if
    unreachable
   end
  else
   local.get $5
   i32.const 57
   i32.le_s
   local.get $5
   i32.const 49
   i32.ge_s
   i32.and
   if
    loop $while-continue|0
     local.get $0
     call $assembly/index/Parser#peek
     i32.const 48
     i32.ge_s
     if (result i32)
      local.get $0
      call $assembly/index/Parser#peek
      i32.const 57
      i32.le_s
     else
      i32.const 0
     end
     if
      local.get $2
      i32.const 18
      i32.ge_s
      if
       unreachable
      end
      local.get $0
      call $assembly/index/Parser#next
      i32.const 48
      i32.sub
      i64.extend_i32_s
      local.get $3
      i64.const 10
      i64.mul
      i64.add
      local.set $3
      local.get $2
      i32.const 1
      i32.add
      local.set $2
      br $while-continue|0
     end
    end
   else
    unreachable
   end
  end
  i32.const 1
  local.set $2
  local.get $0
  call $assembly/index/Parser#peek
  i32.const 46
  i32.eq
  if
   i32.const 0
   local.set $2
   local.get $0
   local.get $0
   i32.load offset=4
   i32.const 1
   i32.add
   i32.store offset=4
   local.get $0
   call $assembly/index/Parser#peek
   i32.const 48
   i32.ge_s
   if (result i32)
    local.get $0
    call $assembly/index/Parser#peek
    i32.const 57
    i32.le_s
   else
    i32.const 0
   end
   i32.eqz
   if
    unreachable
   end
   loop $while-continue|1
    local.get $0
    call $assembly/index/Parser#peek
    i32.const 48
    i32.ge_s
    if (result i32)
     local.get $0
     call $assembly/index/Parser#peek
     i32.const 57
     i32.le_s
    else
     i32.const 0
    end
    if
     local.get $0
     local.get $0
     i32.load offset=4
     i32.const 1
     i32.add
     i32.store offset=4
     br $while-continue|1
    end
   end
  end
  local.get $0
  call $assembly/index/Parser#peek
  i32.const 101
  i32.eq
  if (result i32)
   i32.const 1
  else
   local.get $0
   call $assembly/index/Parser#peek
   i32.const 69
   i32.eq
  end
  if
   i32.const 0
   local.set $2
   local.get $0
   local.get $0
   i32.load offset=4
   i32.const 1
   i32.add
   i32.store offset=4
   local.get $0
   call $assembly/index/Parser#peek
   i32.const 43
   i32.eq
   if (result i32)
    i32.const 1
   else
    local.get $0
    call $assembly/index/Parser#peek
    i32.const 45
    i32.eq
   end
   if
    local.get $0
    local.get $0
    i32.load offset=4
    i32.const 1
    i32.add
    i32.store offset=4
   end
   local.get $0
   call $assembly/index/Parser#peek
   i32.const 48
   i32.ge_s
   if (result i32)
    local.get $0
    call $assembly/index/Parser#peek
    i32.const 57
    i32.le_s
   else
    i32.const 0
   end
   i32.eqz
   if
    unreachable
   end
   loop $while-continue|2
    local.get $0
    call $assembly/index/Parser#peek
    i32.const 48
    i32.ge_s
    if (result i32)
     local.get $0
     call $assembly/index/Parser#peek
     i32.const 57
     i32.le_s
    else
     i32.const 0
    end
    if
     local.get $0
     local.get $0
     i32.load offset=4
     i32.const 1
     i32.add
     i32.store offset=4
     br $while-continue|2
    end
   end
  end
  i32.const 2
  call $assembly/index/Json#constructor
  local.set $6
  local.get $1
  i32.const 0
  local.get $1
  i32.const 0
  i32.gt_s
  select
  local.tee $7
  local.get $0
  i32.load
  local.tee $1
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 1
  i32.shr_u
  local.tee $5
  local.get $5
  local.get $7
  i32.gt_s
  select
  local.tee $7
  local.get $0
  i32.load offset=4
  local.tee $0
  i32.const 0
  local.get $0
  i32.const 0
  i32.gt_s
  select
  local.tee $0
  local.get $5
  local.get $0
  local.get $5
  i32.lt_s
  select
  local.tee $0
  local.get $0
  local.get $7
  i32.gt_s
  select
  i32.const 1
  i32.shl
  local.set $8
  block $__inlined_func$~lib/string/String#substring
   local.get $7
   local.get $0
   local.get $0
   local.get $7
   i32.lt_s
   select
   i32.const 1
   i32.shl
   local.tee $0
   local.get $8
   i32.sub
   local.tee $7
   i32.eqz
   if
    i32.const 1056
    local.set $0
    br $__inlined_func$~lib/string/String#substring
   end
   local.get $8
   i32.eqz
   local.get $0
   local.get $5
   i32.const 1
   i32.shl
   i32.eq
   i32.and
   if
    local.get $1
    local.set $0
    br $__inlined_func$~lib/string/String#substring
   end
   local.get $7
   i32.const 2
   call $~lib/rt/stub/__new
   local.tee $0
   local.get $1
   local.get $8
   i32.add
   local.get $7
   memory.copy
  end
  local.get $6
  local.get $0
  call $~lib/util/string/strtod
  f64.store offset=8
  local.get $6
  local.get $2
  i32.store8 offset=16
  local.get $6
  i64.const 0
  local.get $3
  i64.sub
  local.get $3
  local.get $4
  select
  i64.store offset=24
  local.get $6
 )
)
