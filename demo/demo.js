function toMinor(value) {
  const text = String(value).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) throw new Error('Введите сумму с точностью до копеек.');
  const [rub, kop = ''] = text.split('.');
  return Number(rub) * 100 + Number(kop.padEnd(2, '0'));
}
const money = n => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: n % 100 ? 2 : 0 }).format(n / 100);
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function addDays(date, n) { const d = new Date(date+'T12:00:00'); d.setDate(d.getDate()+n); return isoDate(d); }
function mondayOf(date) { const d = new Date(date+'T12:00:00'); return addDays(date,-((d.getDay()+6)%7)); }
const weekday = date => (new Date(date+'T12:00:00').getDay()+6)%7;
const sortLessons = lessons => [...lessons].sort((a,b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`) || a.id.localeCompare(b.id));
const isActual = p => p.attendance === 'present' || p.attendance === 'absent' || ['rescheduled','teacher_cancelled'].includes(p.lessonStatus);
const reasonKey = p => ['rescheduled','teacher_cancelled'].includes(p.lessonStatus)?p.lessonStatus:p.reason||'unspecified';
const reasonPolicy = (state,p) => state.settings.reasonRules?.[reasonKey(p)] || state.settings.missPolicy;
const studentSubjects = st => st?.subjects?.length?st.subjects:st?[{id:'base:'+st.id,subject:st.subject,priceMinor:st.priceMinor}]:[];
const subjectFor = (state,p) => p.subject || studentSubjects(state.students.find(s=>s.id===p.studentId)).find(s=>s.id===p.subjectId)?.subject || state.students.find(s=>s.id===p.studentId)?.subject || '';
function feeFor(state, participant) {
  const student = state.students.find(s => s.id === participant.studentId);
  return participant.priceMinor ?? studentSubjects(student).find(s=>s.id===participant.subjectId)?.priceMinor ?? student?.priceMinor ?? 0;
}
function chargeFor(state, p) {
  if ((p.attendance === 'absent' || ['rescheduled','teacher_cancelled'].includes(p.lessonStatus)) && (p.missPolicy || reasonPolicy(state,p)) === 'free') return 0;
  return feeFor(state, p);
}
function completeGroup(lesson) {
  return lesson.isGroup && lesson.participants.length >= 2 && lesson.participants.every(p => p.studentId && isActual(p) && p.paymentConfirmed);
}
function blankParticipant(studentId = '') {
  return { studentId, attendance: 'pending', priceMinor: null, paidMinor: 0, method: 'cash', paymentConfirmed: false, missPolicy: null, ruleOverride: null, lessonStatus:'scheduled', reason:null, paidDate:null, movedToDate:null, movedToTime:null, rescheduledToId:null };
}
function blankState() {
  return { version: 2, students: [], lessons: [], series: [], advances: [], exclusions: [], settings: { missPolicy: 'free' } };
}
// Generate only missing occurrences; attendance, payment and completion never repeat.
function ensureWeek(state, week, uuid = () => crypto.randomUUID()) {
  for (const series of state.series) {
    const date = addDays(week, series.weekday);
    if (date < series.startDate || (series.endDate && date >= series.endDate)) continue;
    const key = `${series.id}:${date}`;
    if (state.exclusions.includes(key) || state.lessons.some(l => l.date === date && (l.seriesId === series.id || (l.seriesRoot || state.series.find(r => r.id === l.seriesId)?.rootId || l.seriesId) === (series.rootId || series.id)))) continue;
    state.lessons.push({ id: uuid(), seriesId: series.id, seriesRoot: series.rootId || series.id, date, time: series.time, durationMinutes: series.durationMinutes ?? 60, isGroup: series.isGroup, label: series.label, collapsed: false,
      participants: series.participants.map(p => ({ ...blankParticipant(p.studentId), priceMinor: p.priceMinor ?? null, subjectId:p.subjectId??null, subject:p.subject??null, missPolicy: p.ruleOverride ?? p.missPolicy ?? null, ruleOverride: p.ruleOverride ?? p.missPolicy ?? null })) });
  }
}
// Stateless allocation: a free absence releases the reservation to the next paid lesson.
// Future reservations are separate from actual spending. Manual payments take precedence.
function ledger(state) {
  const rows = new Map();
  const credits = new Map(state.advances.map(a => [a.id, { ...a, remainingMinor: a.amountMinor, spentMinor: 0, reservedMinor: 0, allocations: [] }]));
  const advances = [...credits.values()].sort((a,b) => a.startDate.localeCompare(b.startDate) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const lesson of sortLessons(state.lessons)) {
    for (const p of lesson.participants) {
      if (!p.studentId) continue;
      const cost = chargeFor(state, p);
      let need = Math.max(0, cost - p.paidMinor), creditMinor = 0;
      for (const a of advances) {
        if (a.studentId !== p.studentId || lesson.date < (a.receivedDate&&a.receivedDate>a.startDate?a.receivedDate:a.startDate) || !a.remainingMinor || !need) continue;
        const amount = Math.min(a.remainingMinor, need);
        a.remainingMinor -= amount;
        a[isActual(p) ? 'spentMinor' : 'reservedMinor'] += amount;
        a.allocations.push({ lessonId: lesson.id, date: lesson.date, amountMinor: amount, actual: isActual(p) });
        need -= amount; creditMinor += amount;
      }
      rows.set(`${lesson.id}:${p.studentId}`, { feeMinor: feeFor(state,p), chargeMinor: cost, creditMinor, paidMinor: p.paidMinor, dueMinor: need, actual: isActual(p), overpaidMinor: Math.max(0,p.paidMinor-cost) });
    }
  }
  return { rows, credits };
}
function syncSeries(state, lesson, repeat, uuid = () => crypto.randomUUID()) {
  let series = state.series.find(s => s.id === lesson.seriesId);
  if (!repeat) {
    if (series) {
      series.endDate = lesson.date;
      state.lessons = state.lessons.filter(l => l.id === lesson.id || l.seriesId !== series.id || l.date < lesson.date || l.participants.some(p => isActual(p) || p.paidMinor || p.paymentConfirmed));
      lesson.seriesId = null;
    }
    return;
  }
  if (series && (lesson.date !== series.startDate || weekday(lesson.date) !== series.weekday)) {
    // Version a recurrence from the edited week; past weeks must never gain phantom lessons.
    const previous = series, cutoff = mondayOf(lesson.date), previousEnd = previous.endDate;
    previous.endDate = cutoff;
    state.lessons = state.lessons.filter(l => l.id === lesson.id || l.seriesId !== previous.id || l.date < cutoff || l.participants.some(p => isActual(p) || p.paidMinor || p.paymentConfirmed));
    series = { id: uuid(), rootId: previous.rootId || previous.id, startDate: lesson.date, endDate: previousEnd && previousEnd > lesson.date ? previousEnd : null };
    state.series.push(series); lesson.seriesId = series.id;
  }
  if (!series) { series = { id: uuid(), startDate: lesson.date }; state.series.push(series); lesson.seriesId = series.id; }
  lesson.seriesRoot = series.rootId || series.id;
  Object.assign(series, { weekday: weekday(lesson.date), time: lesson.time, durationMinutes: lesson.durationMinutes ?? 60, isGroup: lesson.isGroup, label: lesson.label,
    participants: lesson.participants.map(p => ({ studentId: p.studentId, priceMinor: p.priceMinor, subjectId:p.subjectId??null, subject:p.subject??null, missPolicy: p.ruleOverride ?? null, ruleOverride: p.ruleOverride ?? null })) });
  state.lessons = state.lessons.filter(l => l.id === lesson.id || l.seriesId !== series.id || l.date <= lesson.date || l.participants.some(p => isActual(p) || p.paidMinor || p.paymentConfirmed));
}
function validateState(s) {
  const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v+'T12:00:00').getTime()) && isoDate(new Date(v+'T12:00:00')) === v;
  const validMoney = v => Number.isSafeInteger(v) && v >= 0 && v <= 9999999999;
  const id = v => typeof v === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(v);
  const text = (v,n) => typeof v === 'string' && v.length <= n;
  if (!s || s.version !== 2 || !s.settings || !['free','charge'].includes(s.settings.missPolicy)) throw new Error('Неверный формат настроек.');
  for (const field of ['students','lessons','series','advances','exclusions']) if (!Array.isArray(s[field]) || s[field].length > 50000) throw new Error('Неверный формат данных.');
  for (const list of [s.students,s.lessons,s.series,s.advances]) if (new Set(list.map(x=>x.id)).size !== list.length || list.some(x=>!id(x.id))) throw new Error('Повторяющиеся или неверные ID.');
  for (const st of s.students) if (!text(st.name,100) || !st.name.trim() || !text(st.subject,100) || !validMoney(st.priceMinor) || !text(st.contact||'',200)) throw new Error('Некорректная карточка ученика.');
  const studentIds = new Set(s.students.map(st=>st.id));
  function checkParticipants(ps, actual) {
    if (!Array.isArray(ps) || ps.length < 1 || ps.length > 15 || new Set(ps.map(p=>p.studentId)).size !== ps.length) throw new Error('Некорректный состав занятия.');
    for (const p of ps) {
      if (!studentIds.has(p.studentId) || (p.priceMinor !== null && !validMoney(p.priceMinor)) || (p.missPolicy != null && !['free','charge'].includes(p.missPolicy)) || (p.ruleOverride != null && !['free','charge'].includes(p.ruleOverride))) throw new Error('Неверный ученик или стоимость.');
      if (actual && (!['present','absent','pending'].includes(p.attendance) || !validMoney(p.paidMinor) || !['cash','transfer'].includes(p.method) || typeof p.paymentConfirmed !== 'boolean')) throw new Error('Неверная отметка занятия.');
    }
  }
  const validTime = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  for (const l of s.lessons) {
    if ((l.durationMinutes !== undefined && (!Number.isInteger(l.durationMinutes) || l.durationMinutes < 5 || l.durationMinutes > 720)) || (l.replacementOf != null && !id(l.replacementOf)) || !validDate(l.date) || !validTime(l.time) || !text(l.label,100) || typeof l.isGroup !== 'boolean' || typeof l.collapsed !== 'boolean' || (!l.isGroup && l.participants?.length !== 1) || (l.isGroup && l.participants?.length < 2)) throw new Error('Некорректное занятие.');
    checkParticipants(l.participants,true);
  }
  for (const r of s.series) {
    if (!validDate(r.startDate) || (r.endDate && !validDate(r.endDate)) || !Number.isInteger(r.weekday) || r.weekday<0 || r.weekday>6 || !validTime(r.time) || !text(r.label,100) || typeof r.isGroup !== 'boolean') throw new Error('Неверное повторение.');
    checkParticipants(r.participants,false);
  }
  for (const a of s.advances) if (!studentIds.has(a.studentId) || !validMoney(a.amountMinor) || !a.amountMinor || !validDate(a.startDate) || !text(a.createdAt,40) || !Number.isFinite(Date.parse(a.createdAt))) throw new Error('Неверный аванс.');
  if (s.exclusions.some(v=>!text(v,200))) throw new Error('Неверные исключения.');
  const subjectIds = st => studentSubjects(st).map(x=>x.id);
  for(const st of s.students){
    if(st.subjects!==undefined&&(!Array.isArray(st.subjects)||st.subjects.length<1||st.subjects.length>20||new Set(subjectIds(st)).size!==st.subjects.length||st.subjects.some(x=>!id(x.id)||!text(x.subject,100)||!x.subject.trim()||!validMoney(x.priceMinor))))throw new Error('Проверьте предметы и стоимость ученика.');
    if(st.parents!==undefined&&(!Array.isArray(st.parents)||st.parents.length>10||st.parents.some(p=>!id(p.id)||!text(p.name||'',100)||!text(p.relationship||'',60)||!text(p.phone||'',100)||!text(p.messenger||'',100))))throw new Error('Проверьте контакты родителей.');
    for(const field of ['childPhone','childMessenger'])if(st[field]!=null&&!text(st[field],100))throw new Error('Слишком длинный контакт ребёнка.');
    if(st.grade!=null&&!text(st.grade,50)||st.comment!=null&&!text(st.comment,2000)||st.status!=null&&!['active','archived'].includes(st.status))throw new Error('Неверные данные карточки ученика.');
    if(st.learning!=null){
      if(!Array.isArray(st.learning)||st.learning.length>50000)throw new Error('Неверные учебные записи ученика.');
      for(const note of st.learning){
        if(!note||typeof note!=='object'||Array.isArray(note)||note.lessonId!=null&&note.lessonId!==''&&!id(note.lessonId)||note.subjectId!=null&&note.subjectId!==''&&!id(note.subjectId))throw new Error('Неверная учебная запись ученика.');
        if(note.score!=null&&(!Number.isInteger(note.score)||note.score<1||note.score>5))throw new Error('Оценка за урок должна быть от 1 до 5.');
        if(note.topic!=null&&!text(note.topic,300)||note.homework!=null&&!text(note.homework,3000)||note.dueDate!=null&&note.dueDate!==''&&!validDate(note.dueDate)||note.homeworkStatus!=null&&!['assigned','done','review'].includes(note.homeworkStatus))throw new Error('Проверьте тему и домашнее задание.');
      }
    }
  }
  if(s.tutor!=null){for(const [key,limit] of Object.entries({name:100,phone:100,messenger:100,email:200,city:100,subjects:500,grades:200,education:2000,experience:500,availability:1000,bio:3000}))if(!text(s.tutor[key]||'',limit))throw new Error('Проверьте анкету преподавателя.');if(!['online','inperson','both'].includes(s.tutor.format)||!Number.isInteger(s.tutor.freeSlots)||s.tutor.freeSlots<0||s.tutor.freeSlots>100)throw new Error('Проверьте формат и свободные места.');}
  if(s.settings.reasonRules&&Object.entries(s.settings.reasonRules).some(([k,v])=>!['illness','no_show','rescheduled','teacher_cancelled','unspecified'].includes(k)||!['free','charge'].includes(v)))throw new Error('Неверные правила причин пропуска.');
  const lessonIds=new Set(s.lessons.map(l=>l.id));
  for(const l of s.lessons)for(const p of l.participants){
    if(p.subject!=null&&!text(p.subject,100)||p.subjectId!=null&&!id(p.subjectId))throw new Error('Неверный предмет занятия.');
    if(p.lessonStatus!=null&&!['scheduled','conducted','missed','rescheduled','teacher_cancelled'].includes(p.lessonStatus)||p.reason!=null&&!['illness','no_show','unspecified'].includes(p.reason))throw new Error('Неверная причина отсутствия.');
    if(p.paidDate!=null&&!validDate(p.paidDate)||p.movedToDate!=null&&!validDate(p.movedToDate)||p.movedToTime!=null&&!validTime(p.movedToTime)||p.rescheduledToId!=null&&!lessonIds.has(p.rescheduledToId))throw new Error('Неверная дата оплаты или ссылка переноса.');
  }
  for(const a of s.advances)if(a.receivedDate!=null&&!validDate(a.receivedDate))throw new Error('Неверная дата получения аванса.');
  return s;
}

function lessonTimeRange(lesson) {
  const [h,m]=lesson.time.split(':').map(Number);
  const end=h*60+m+(lesson.durationMinutes??60);
  return `${lesson.time}–${String(Math.floor(end/60)%24).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`;
}
function replacementDraft(state, sourceId, uuid=()=>crypto.randomUUID()) {
  const source=state.lessons.find(l=>l.id===sourceId);
  if(!source || source.isGroup || source.participants.length!==1 || source.participants[0].attendance!=='absent')throw new Error('Замена доступна для индивидуального занятия с отметкой пропуска.');
  return {id:uuid(),seriesId:null,replacementOf:source.id,date:source.date,time:source.time,durationMinutes:source.durationMinutes??60,label:'',isGroup:false,collapsed:false,participants:[blankParticipant()]};
}

// A grade belongs to one student and one occurrence, including group lessons.
function saveStudentLessonScore(state,studentId,lessonId,subjectId,score){
 if(score!==null&&(!Number.isInteger(score)||score<1||score>5))throw new Error('Оценка за урок должна быть от 1 до 5.');
 const st=state.students.find(s=>s.id===studentId),lesson=state.lessons.find(l=>l.id===lessonId);
 if(!st||!lesson?.participants.some(p=>p.studentId===studentId)||!subjectId)throw new Error('Не найдено занятие ученика.');
 const notes=st.learning||[],index=notes.findIndex(n=>n.lessonId===lessonId&&n.subjectId===subjectId);
 if(index<0&&score===null)return;
 const note={...(index>=0?notes[index]:{}),lessonId,subjectId,score};
 st.learning=index<0?[...notes,note]:notes.map((n,i)=>i===index?note:n);
}

const reasonLabels={illness:'Болезнь ученика',no_show:'Неявка',unspecified:'Причина не указана',rescheduled:'Перенос занятия',teacher_cancelled:'Не смог преподаватель'};
function upgradeState(value) {
  const state=JSON.parse(JSON.stringify(value));
  state.settings.reasonRules??=Object.fromEntries(['illness','no_show','rescheduled','teacher_cancelled','unspecified'].map(k=>[k,state.settings.missPolicy]));
  state.tutor??={name:'',phone:'',messenger:'',email:'',city:'',subjects:'',grades:'',education:'',experience:'',availability:'',bio:'',format:'online',freeSlots:0};
  for(const st of state.students){
    st.subjects=studentSubjects(st);st.subject=st.subjects[0].subject;st.priceMinor=st.subjects[0].priceMinor;
    st.parents??=[];st.childPhone??='';st.childMessenger??='';st.grade??='';st.comment??='';st.status??='active';
  }
  for(const l of state.lessons)for(const p of l.participants){
    const st=state.students.find(s=>s.id===p.studentId);
    p.subjectId??=st?.subjects[0].id??null;p.subject??=st?.subject??'';
    p.lessonStatus??=p.attendance==='present'?'conducted':p.attendance==='absent'?'missed':'scheduled';
    if(p.attendance==='absent'){p.reason??='unspecified';p.missPolicy??=state.settings.missPolicy;}
  }
  for(const series of state.series)for(const p of series.participants){const st=state.students.find(s=>s.id===p.studentId);p.subjectId??=st?.subjects[0].id??null;p.subject??=st?.subject??'';}
  return state;
}
const receiptDate = (lesson,p) => p.paidDate||lesson.date;
const advanceReceiptDate = advance => advance.receivedDate||advance.startDate;
function attendanceLabel(p) {
  if(p.lessonStatus==='rescheduled')return 'Перенос';
  if(p.lessonStatus==='teacher_cancelled')return 'Отмена преподавателем';
  return {present:'Присутствовал',absent:'Пропустил',pending:'Не отмечено'}[p.attendance];
}
function studentReport(state,studentId,from,to) {
  const valid=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T12:00:00'))&&isoDate(new Date(v+'T12:00:00'))===v;
  if(!valid(from)||!valid(to)||from>to)throw new Error('Укажите корректный период: начало не позднее окончания.');
  if(!state.students.some(s=>s.id===studentId))throw new Error('Карточка ученика не найдена.');
  const through=JSON.parse(JSON.stringify(state));
  through.advances=through.advances.filter(a=>advanceReceiptDate(a)<=to);
  through.lessons=through.lessons.filter(l=>l.date<=to).map(l=>({...l,participants:l.participants.map(p=>receiptDate(l,p)>to?{...p,paidMinor:0}:p)}));
  const led=ledger(through),counts={present:0,absent:0,rescheduled:0,teacherCancelled:0,pending:0};
  const visits=[];let chargedMinor=0,debtMinor=0,overpaidMinor=0;
  for(const lesson of through.lessons){
    if(lesson.date<from)continue;
    const p=lesson.participants.find(p=>p.studentId===studentId);if(!p)continue;
    const row=led.rows.get(`${lesson.id}:${studentId}`);
    if(p.lessonStatus==='rescheduled')counts.rescheduled++;
    else if(p.lessonStatus==='teacher_cancelled')counts.teacherCancelled++;
    else counts[p.attendance==='present'?'present':p.attendance==='absent'?'absent':'pending']++;
    let reason=p.lessonStatus==='rescheduled'?'rescheduled':p.lessonStatus==='teacher_cancelled'?'teacher_cancelled':p.attendance==='absent'?p.reason||'unspecified':null;
    visits.push({lessonId:lesson.id,date:lesson.date,time:lesson.time,subject:subjectFor(state,p),status:attendanceLabel(p),reason:reason?reasonLabels[reason]:'',movedToDate:p.movedToDate||null,movedToTime:p.movedToTime||null,amountMinor:row.actual?row.chargeMinor:0,financialActual:row.actual,policy:p.ruleOverride||p.missPolicy||null});
    if(row.actual){chargedMinor+=row.chargeMinor;debtMinor+=row.dueMinor;overpaidMinor+=row.overpaidMinor;}
  }
  const operations=[];let receivedMinor=0,advanceReceivedMinor=0,advanceSpentMinor=0,openingAdvanceMinor=0,endingAdvanceMinor=0;
  for(const l of state.lessons)for(const p of l.participants){if(p.studentId!==studentId||!p.paidMinor)continue;const date=receiptDate(l,p);if(date>=from&&date<=to){receivedMinor+=p.paidMinor;operations.push({date,type:p.method==='transfer'?'Перевод':'Наличные',description:`За занятие ${l.date} · ${subjectFor(state,p)}`,incomingMinor:p.paidMinor,spentMinor:0,assumedDate:!p.paidDate});}}
  for(const a of through.advances.filter(a=>a.studentId===studentId)){
    const date=advanceReceiptDate(a),credit=led.credits.get(a.id),spent=credit.allocations.filter(x=>x.actual),spentBefore=spent.filter(x=>x.date<from).reduce((n,x)=>n+x.amountMinor,0);
    if(date<from)openingAdvanceMinor+=a.amountMinor-spentBefore;
    endingAdvanceMinor+=a.amountMinor-credit.spentMinor;
    if(date>=from&&date<=to){advanceReceivedMinor+=a.amountMinor;receivedMinor+=a.amountMinor;operations.push({date,type:'Получен аванс',description:'Поступление денег; списания ниже не являются повторным доходом',incomingMinor:a.amountMinor,spentMinor:0,assumedDate:!a.receivedDate});}
    for(const x of spent.filter(x=>x.date>=from&&x.date<=to)){advanceSpentMinor+=x.amountMinor;operations.push({date:x.date,type:'Списано из аванса',description:'Оплата начисления по занятию',incomingMinor:0,spentMinor:x.amountMinor,assumedDate:false});}
  }
  visits.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));operations.sort((a,b)=>a.date.localeCompare(b.date)||Number(b.incomingMinor>0)-Number(a.incomingMinor>0));
  return {studentId,from,to,visits,counts,operations,receivedMinor,advanceReceivedMinor,advanceSpentMinor,openingAdvanceMinor,endingAdvanceMinor,chargedMinor,debtMinor,overpaidMinor,hasAssumedDates:operations.some(x=>x.assumedDate)};
}
function reportText(state,studentId,from,to,tab) {
  const data=studentReport(state,studentId,from,to),st=state.students.find(s=>s.id===studentId);
  const lines=[`РепетЖурнал · ${tab==='payments'?'Оплаты':'Посещаемость'}`,`Ученик: ${st.name}`,`Период: ${from} — ${to}`,''];
  if(tab==='payments'){
    for(const row of data.operations)lines.push(`${row.date} · ${row.type} · ${row.incomingMinor?'получено '+money(row.incomingMinor):'списано '+money(row.spentMinor)} · ${row.description}${row.assumedDate?' (дата условная)':''}`);
    lines.push('',`Поступило денег: ${money(data.receivedMinor)}`,`Из них аванс: ${money(data.advanceReceivedMinor)}`,`Списано аванса: ${money(data.advanceSpentMinor)}`,`Начислено за отмеченные занятия: ${money(data.chargedMinor)}`,`Долг по занятиям периода на конец периода: ${money(data.debtMinor)}`,`Аванс на начало периода: ${money(data.openingAdvanceMinor)}`,`Аванс на конец периода: ${money(data.endingAdvanceMinor)}`);
    if(data.overpaidMinor)lines.push(`Переплата по занятиям периода: ${money(data.overpaidMinor)}`);
    if(data.hasAssumedDates)lines.push('В старых записях без даты получения использована дата урока / начала аванса.');
  }else{
    for(const row of data.visits)lines.push(`${row.date} ${row.time} · ${row.subject} · ${row.status}${row.reason?' · '+row.reason:''}${row.movedToDate?' → '+row.movedToDate+' '+row.movedToTime:''} · ${row.financialActual?'начислено '+money(row.amountMinor):'начисление не зафиксировано'}`);
    lines.push('',`Посещений: ${data.counts.present}`,`Пропусков ученика: ${data.counts.absent}`,`Переносов: ${data.counts.rescheduled}`,`Отмен преподавателем: ${data.counts.teacherCancelled}`,`Не отмечено: ${data.counts.pending}`);
  }
  if(!(tab==='payments'?data.operations.length:data.visits.length))lines.push('За этот период записей нет.');
  return lines.join('\n');
}

(async()=>{
'use strict';
const trainingMode=true;
const offline={canEdit:()=>true,mount:()=>{},stage:async()=>{}};
const boot={accountId:'public-demo',revision:0,state:demoState()};
function demoState() {
 const value=blankState();
 value.students=[['anna','Анна','Математика',200000],['lev','Лев','Русский язык',180000],['dasha','Даша','Английский язык',220000]].map(([id,name,subject,priceMinor])=>({id,name,subject,priceMinor,contact:'',grade:'7 класс',learning:[]}));
 const start=mondayOf(isoDate(new Date()));
 for(let day=0;day<6;day++) for(let slot=0;slot<2;slot++) {
  const st=value.students[(day+slot)%3];
  const p={...blankParticipant(st.id)};
  if(day<weekday(isoDate(new Date()))){p.attendance='present';p.lessonStatus='conducted';p.paidMinor=slot?st.priceMinor:Math.floor(st.priceMinor/2);p.paymentConfirmed=true;}
  value.lessons.push({id:'demo-'+day+'-'+slot,seriesId:null,date:addDays(start,day),time:slot?'17:00':'15:00',durationMinutes:60,label:'',isGroup:false,collapsed:false,participants:[p]});
 }
 return value;
}
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = value => JSON.parse(JSON.stringify(value));

const DAYS = ['ПОНЕДЕЛЬНИК','ВТОРНИК','СРЕДА','ЧЕТВЕРГ','ПЯТНИЦА','СУББОТА','ВОСКРЕСЕНЬЕ'];
const COLORS = ['var(--green)','var(--blue)','var(--yellow)','var(--pink)','var(--green)','var(--lav)','var(--blue)'];
let blockedStorage = false, state = blankState(), week = mondayOf(isoDate(new Date())), draft = null, editingStudentId = null, newStudentTarget = null;
let editingWasComplete = false, autoClosing = false;
let selectedPage = weekday(isoDate(new Date())) >= 3 ? 1 : 0;
function updateHiddenLessons() {
  document.querySelectorAll('.day').forEach(day=>{
    const list=day.querySelector('.day-entries'), badge=day.querySelector('.hidden-lessons');
    if (!list || !badge || !list.clientHeight) return;
    const headerHeight=list.querySelector('thead').getBoundingClientRect().height;
    const rowHeight=Math.max(19,(list.clientHeight-headerHeight-1)/5);
    list.style.setProperty('--lesson-row-height',`${rowHeight}px`);
    list.style.setProperty('--lesson-font',`${Math.min(18,Math.max(12,Math.floor(rowHeight*.52)))}px`);
    const rows=[...list.querySelectorAll('tbody > tr:not(.member):not([aria-hidden])')];
    badge.hidden=rows.length<=5;
    badge.textContent=String(rows.length);
    badge.title=`Всего уроков: ${rows.length}`;
    badge.setAttribute('aria-label',badge.title);
  });
}
function fitDiary() {
  const book=document.querySelector('.book');
  const available=Math.max(480,window.innerHeight-book.getBoundingClientRect().top-8);
  book.style.setProperty('--book-height',`${available}px`);
  requestAnimationFrame(updateHiddenLessons);
}
function showDiaryPage(page) {
  selectedPage=page;
  document.querySelector('.book').dataset.page=String(page);
  $('firstPage').setAttribute('aria-pressed',String(page===0));
  $('secondPage').setAttribute('aria-pressed',String(page===1));
  fitDiary();
}
$('firstPage').onclick=()=>showDiaryPage(0);
$('secondPage').onclick=()=>showDiaryPage(1);
window.addEventListener('resize',fitDiary);
window.matchMedia('(orientation: portrait)').addEventListener('change',fitDiary);
if (window.ResizeObserver) new ResizeObserver(fitDiary).observe(document.querySelector('.bar'));
document.documentElement.dataset.diaryAccount=boot.accountId;
const STARTER_STATE=boot.state;
state=validateState(upgradeState(STARTER_STATE));
let remoteRevision=boot.revision,lastServerState=JSON.stringify(state);
function warnSave(message){blockedStorage=true;$('storageAlert').hidden=false;$('storageAlert').textContent=message+' Не закрывайте страницу, пока сохранение не подтверждено. Можно скачать копию через «Правила → Сохранить».';$('saveStatus').textContent='Сохранение не подтверждено. ';}
function persist(){
 if(trainingMode){try{validateState(state);lastServerState=JSON.stringify(state);$('saveStatus').textContent='Пробный дневник · изменения до обновления страницы. ';return true;}catch{return false;}}
 if(blockedStorage||!offline.canEdit())return false;
 try{validateState(state);lastServerState=JSON.stringify(state);void offline.stage(JSON.parse(lastServerState)).catch(e=>warnSave(e.message));return true;}catch(e){warnSave(e.message);return false;}
}
let toastTimer;
function toast(text) { $('toast').textContent=text; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,4000); }
function show(id) { const d=$(id); if (!d.open) d.showModal(); }
function close(id) { $(id).close(); }
document.addEventListener('click',e=>{ const b=e.target.closest('[data-close]'); if(b) close(b.dataset.close); });
function student(id) { return state.students.find(s=>s.id===id); }
function studentText(s) { return `${s.name} · ${s.subject}`; }
function findStudent(text) { return state.students.find(s=>studentText(s)===text.trim()) || state.students.find(s=>s.name.toLocaleLowerCase('ru')===text.trim().toLocaleLowerCase('ru')); }
function formatDate(date) { return /^\d{4}-\d{2}-\d{2}$/.test(date||'')?date.split('-').reverse().join('.'):date||''; }
function materialize(anchor=week) {
  ensureWeek(state, anchor);
  // A rolling year provides future slots for credit reservations without copying money.
  if (state.advances.length) {
    const starts = new Set([anchor, ...state.advances.map(a=>mondayOf(a.startDate))]);
    for (const start of starts) for(let i=0;i<52;i++) ensureWeek(state,addDays(start,i*7));
  }
}
function paymentMarkup(row, p) {
  if (!row) return '<span class="sub">Указать оплату</span>';
  const lines=[];
  if (row.paidMinor) lines.push(`<span class="pay-main">${money(row.paidMinor)}</span> <span class="sub">${p.method==='transfer'?'перевод':'наличные'}</span>`);
  if (row.creditMinor) lines.push(`<span class="${row.actual?'pay-main':'future'}">${row.dueMinor?'Хвост аванса':'Аванс'} ${money(row.creditMinor)}</span><span class="sub">${row.actual?'списано':'резерв на урок'}</span>`);
  if (!row.chargeMinor && p.attendance==='absent') lines.push('<span class="sub">Без оплаты</span>');
  else if (row.dueMinor) lines.push(`<span class="${row.actual?'debt':'sub'}">${row.actual?'Долг':'К оплате'} ${money(row.dueMinor)}</span>`);
  if (row.overpaidMinor) lines.push(`<span class="sub">Переплата ${money(row.overpaidMinor)} · проверить</span>`);
  if (!lines.length) lines.push('<span class="sub">Без оплаты</span>');
  return lines.join('');
}
function render() {
  materialize(); persist();
  const led=ledger(state), end=addDays(week,5), today=isoDate(new Date());
  $('datePick').value=week;
  const weekly=sortLessons(state.lessons.filter(l=>l.date>=week && l.date<=addDays(week,6)));
  const debt=weekly.flatMap(l=>l.participants.map(p=>led.rows.get(`${l.id}:${p.studentId}`))).filter(Boolean).reduce((n,r)=>n+(r.actual?r.dueMinor:0),0);
  const balance=[...led.credits.values()].reduce((n,c)=>n+c.amountMinor-c.spentMinor,0);
  $('summary').innerHTML=`<span>Занятий на неделе: <b>${weekly.length}</b></span><span>Долг по отмеченным урокам: <b>${money(debt)}</b></span><span>Остаток авансов: <b>${money(balance)}</b></span>`;
  $('page1').replaceChildren(); $('page2').replaceChildren(); $('sundayExtras').replaceChildren();$('sundayExtras').hidden=true;
  const days=weekly.some(l=>weekday(l.date)===6)?7:6;
  for(let i=0;i<days;i++) {
    const date=addDays(week,i), lessons=weekly.filter(l=>l.date===date);
    const section=document.createElement('section'); section.className='day'+(date===today?' today':'');
    let html=`<div class="day-label" style="background:${COLORS[i]}"><span class="day-name">${DAYS[i]}</span><span class="hidden-lessons" hidden></span></div><div class="day-content"><div class="date-line">${formatDate(date,{day:'numeric',month:'long',year:'numeric'})}${date===today?' · сегодня':''}</div><div class="day-entries" tabindex="0" aria-label="Список занятий"><table><thead><tr><th scope="col">Время</th><th scope="col">Ученик</th><th scope="col">+/−</th><th scope="col">Оплата</th><th scope="col">Оценка</th></tr></thead><tbody>`;
    for(const l of lessons) {
      const rows=l.participants.map(p=>led.rows.get(`${l.id}:${p.studentId}`)).filter(Boolean);
      const nPresent=l.participants.filter(p=>p.attendance==='present').length;
      const nAbsent=l.participants.filter(p=>p.attendance==='absent').length;
      if(l.isGroup) {
        const manual=rows.reduce((n,r)=>n+r.paidMinor,0), credit=rows.reduce((n,r)=>n+r.creditMinor,0), due=rows.reduce((n,r)=>n+(r.actual?r.dueMinor:0),0);
        const pay=[manual?`<span class="pay-main">Оплата ${money(manual)}</span>`:'',credit?`<span class="sub">${rows.some(r=>r.creditMinor&&r.dueMinor)?'Хвост аванса':'Аванс'} ${money(credit)}</span>`:'',due?`<span class="debt">Долг ${money(due)}</span>`:''].filter(Boolean).join('')||'<span class="sub">Указать оплату</span>';
        html+=`<tr data-parent-date="${esc(l.date)}" data-parent-time="${esc(l.time)}" data-parent-group="${esc(JSON.stringify(l.participants.filter(p=>!["rescheduled","teacher_cancelled"].includes(p.lessonStatus)).map(p=>p.studentId)))}" data-parent-occurrence="${esc(l.seriesId?`${l.seriesRoot||l.seriesId}:${l.date}`:l.id)}"><td><button data-edit="${esc(l.id)}">${esc(lessonTimeRange(l))} ${l.seriesId?'<span class="repeat" title="Каждую неделю">↻</span>':''}</button></td><td><button data-toggle="${esc(l.id)}"><span class="student-name">${l.collapsed?'▸':'▾'} ${esc(l.label||'Группа')}</span><span class="sub">${l.participants.length} учен. · <span class="group-info">нажмите, чтобы ${l.collapsed?'раскрыть':'свернуть'}</span></span></button></td><td><button class="att ${nAbsent?'absent':nPresent===l.participants.length?'present':'pending'}" data-group-attendance="${esc(l.id)}" aria-label="Посещаемость группы — раскрыть участников">${nPresent}/${l.participants.length}</button></td><td><button data-edit="${esc(l.id)}" aria-label="Оплата группы">${pay}</button></td><td><button data-group-attendance="${esc(l.id)}" aria-label="Оценки группы — раскрыть участников">—</button></td></tr>`;
        if(!l.collapsed) for(const p of l.participants) html+=memberRow(l,p,led,true);
      } else html+=memberRow(l,l.participants[0],led,false);
    }
    for(let n=lessons.length;n<5;n++) html+=`<tr aria-hidden="true"><td class="empty"></td><td></td><td class="empty">—</td><td></td><td></td></tr>`;
    html+=`</tbody></table></div><div class="actions"><button data-add="${date}">+ занятие</button></div></div>`;
    section.innerHTML=html; if(i===6){$('sundayExtras').hidden=false;$('sundayExtras').append(section);}else $(i<3?'page1':'page2').append(section);
  }
  document.querySelectorAll('.day-entries td button').forEach(b=>b.title=b.textContent.trim().replace(/\s+/g,' '));
  document.querySelectorAll('.day-entries').forEach(list=>list.addEventListener('scroll',updateHiddenLessons,{passive:true}));
  updateDatalists();showDiaryPage(selectedPage);
}
function memberRow(l,p,led,member) {
  const st=student(p.studentId), att={pending:'—',present:'+',absent:'−'}[p.attendance];
  return `<tr class="${member?'member':''}" ${["rescheduled","teacher_cancelled"].includes(p.lessonStatus)?"":`data-parent-date="${esc(l.date)}" data-parent-time="${esc(l.time)}" data-parent-occurrence="${esc(l.seriesId?`${l.seriesRoot||l.seriesId}:${l.date}`:l.id)}" data-parent-student="${esc(p.studentId)}"`}><td>${member?'':`<button data-edit="${esc(l.id)}">${esc(lessonTimeRange(l))} ${l.seriesId?'<span class="repeat" title="Каждую неделю">↻</span>':''}</button>`}</td><td><button data-edit="${esc(l.id)}" data-focus-student="${esc(p.studentId)}"><span class="student-name ${member?'member-name':''}">${esc(st?.name||'Выбрать ученика')}</span><span class="sub">${esc(subjectFor(state,p))}</span>${['rescheduled','teacher_cancelled'].includes(p.lessonStatus)?`<span class="replacement-label">${p.lessonStatus==='rescheduled'?'Перенос → '+esc(formatDate(p.movedToDate)):'Отмена преподавателем'}</span>`:''}${l.replacementOf?'<span class="replacement-label">Разовая замена</span>':''}</button>${!member&&p.attendance==='absent'?`<button class="slot-action" data-replace="${esc(l.id)}">+ ученик на это время</button>`:''}</td><td><button class="att ${p.attendance}" data-att="${esc(l.id)}" data-student="${esc(p.studentId)}" aria-label="Посещаемость ${esc(st?.name)}: ${esc(att)}">${att}</button></td><td><button data-edit="${esc(l.id)}" data-focus-payment="${esc(p.studentId)}" aria-label="Оплата ${esc(st?.name)}">${paymentMarkup(led.rows.get(`${l.id}:${p.studentId}`),p)}</button></td><td><button class="lesson-score" data-grade="${esc(l.id)}" data-student="${esc(p.studentId)}" aria-label="Оценка за урок: ${esc(st?.name)}">${lessonScore(l,p)??'—'}</button></td></tr>`;
}
document.querySelector('.book').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b)return;
  if(b.dataset.grade){openLessonGrade(b.dataset.grade,b.dataset.student);return;}
  if(b.dataset.replace){openReplacement(b.dataset.replace);return;}
  if(b.dataset.add) openLesson(null,b.dataset.add);
  if(b.dataset.edit) { openLesson(b.dataset.edit); if(b.dataset.focusPayment) document.querySelector(`[data-card-student="${b.dataset.focusPayment}"] [data-field="choice"]`)?.focus(); }
  if(b.dataset.toggle) { const l=state.lessons.find(l=>l.id===b.dataset.toggle); l.collapsed=!l.collapsed;render(); }
  if(b.dataset.att) quickAttendance(b.dataset.att,b.dataset.student);
  if(b.dataset.groupAttendance){const l=state.lessons.find(l=>l.id===b.dataset.groupAttendance);l.collapsed=false;render();}
});
function updateDatalists() {
  $('studentNames').innerHTML=state.students.filter(s=>s.status!=='archived').map(s=>`<option value="${esc(studentText(s))}"></option>`).join('')+'<option value="Группа"></option>';
  $('subjectNames').innerHTML=[...new Set(state.students.flatMap(s=>studentSubjects(s).map(x=>x.subject)))].map(s=>`<option value="${esc(s)}"></option>`).join('');
}
function options(values,selected) { return values.map(([v,label])=>`<option value="${esc(v)}"${String(selected)===v?' selected':''}>${esc(label)}</option>`).join(''); }
function quickAttendance(id,studentId){
 if(blockedStorage){toast('Обновите страницу: сохранение заблокировано.');return;}
 const l=state.lessons.find(l=>l.id===id),p=l?.participants.find(p=>p.studentId===studentId);if(!p)return;
 if(['rescheduled','teacher_cancelled'].includes(p.lessonStatus)){toast('Это перенос или отмена. Измените статус через время занятия.');return;}
 if(p.attendance==='absent'&&state.lessons.some(x=>x.replacementOf===id||x.id===p.rescheduledToId)){toast('У занятия есть замена или перенос. Измените его через время занятия.');return;}
 const old=clone(p);p.attendance=p.attendance==='present'?'absent':'present';p.lessonStatus=p.attendance==='present'?'conducted':'missed';p.reason=p.attendance==='absent'?'unspecified':null;p.missPolicy=p.attendance==='absent'?(p.ruleOverride||reasonPolicy(state,p)):null;
 if(!persist()){Object.assign(p,old);return;}render();
}
function participantChoice(p) { return p.settlement ?? (!p.paymentConfirmed?'':p.paidMinor?p.method:'debt'); }
let lessonScoreDrafts=new Map();
function scoreDraftKey(p){return JSON.stringify([p.studentId,lessonSubjectId(p)]);}
function participantScore(p){return lessonScoreDrafts.get(scoreDraftKey(p))?.score??(lessonScoreDrafts.has(scoreDraftKey(p))?null:lessonScore(draft,p));}
function openLesson(id,date) {
  lessonScoreDrafts=new Map();
  autoClosing=false;
  const existing=id&&state.lessons.find(l=>l.id===id);
  draft=existing?clone(existing):{id:crypto.randomUUID(),seriesId:null,date:date||isoDate(new Date()),time:'15:00',durationMinutes:60,label:'',isGroup:false,collapsed:false,participants:[blankParticipant()]};
  if(!existing) {
    const times=state.lessons.filter(l=>l.date===draft.date).map(l=>l.time).sort();
    if(times.length) {const [h,m]=times.at(-1).split(':').map(Number);draft.time=`${String(Math.min(23,h+1)).padStart(2,'0')}:${String(m).padStart(2,'0')}`;}
  }
  editingWasComplete=existing?completeGroup(existing):false;
  $('lessonTitle').textContent=existing?'Изменить занятие':'Новое занятие';
  $('lessonDate').value=draft.date;$('lessonTime').value=draft.time;$('lessonDuration').value=draft.durationMinutes??60;
  $('replacementNotice').hidden=!draft.replacementOf;
  if(draft.replacementOf)$('replacementNotice').textContent='Это отдельное занятие вместо пропущенного. Исходный пропуск и его оплаты сохраняются.';
  $('replaceLesson').hidden=!existing||existing.isGroup||existing.participants[0].attendance!=='absent';
  $('lessonLabel').value=draft.isGroup?draft.label:student(draft.participants[0].studentId)?studentText(student(draft.participants[0].studentId)):'';
  const series=state.series.find(s=>s.id===draft.seriesId);
  $('repeatLesson').checked=existing?!!series&&(!series.endDate||draft.date<series.endDate):true;
  $('removeLesson').hidden=!existing;$('lessonError').textContent='';
  renderParticipants();show('lessonDialog');if(!existing)$('lessonLabel').focus();
}
function renderParticipants() {
  $('countField').hidden=!draft.isGroup;$('changeCount').textContent=`${draft.participants.length} ученика`;
  $('groupHint').hidden=!draft.isGroup;
  $('labelHint').textContent=draft.isGroup?'Название группы можно изменить. Данные каждого ученика — ниже.':'Выберите имя из подсказки. Нового ученика можно добавить кнопкой ниже.';
  const led=ledger(state);
  $('participants').innerHTML=draft.participants.map((p,i)=>{
    const st=student(p.studentId), row=led.rows.get(`${draft.id}:${p.studentId}`), choice=participantChoice(p);
    return `<section class="participant" data-index="${i}" data-card-student="${esc(p.studentId)}"><div class="participant-head"><span>${draft.isGroup?`Ученик ${i+1}`:'Карточка занятия'}</span><span>${st?`<button type="button" class="link" data-open-student="${i}">Карточка ученика</button>`:''}<button type="button" class="link" data-new-student="${i}">+ Новый ученик</button></span></div>${draft.isGroup?`<label class="field">Имя<select data-field="studentId" required>${options([['','Выберите ученика'],...state.students.filter(s=>s.status!=='archived'||s.id===p.studentId).map(s=>[s.id,studentText(s)])],p.studentId)}</select></label>`:''}
    <div class="fields"><label class="field">Предмет<select data-field="subjectId" ${st?'':'disabled'}>${options(st?subjectOptions(st,p):[['','Выберите ученика выше']],p.subjectId||studentSubjects(st)[0]?.id||'')}</select></label><label class="field">Цена из карточки, ₽<input data-field="price" readonly aria-readonly="true" inputmode="decimal" value="${st?((p.priceMinor??st.priceMinor)/100):''}" required></label></div>
    <div class="row-fields"><label class="field">Посещаемость<select data-field="attendance">${options([['pending','— Не отмечено'],['present','+ Присутствовал'],['absent','− Пропустил'],['rescheduled','Перенос занятия'],['teacher_cancelled','Не смог преподаватель']],['rescheduled','teacher_cancelled'].includes(p.lessonStatus)?p.lessonStatus:p.attendance)}</select></label><label class="field">Оплата<select data-field="choice">${options([['','— Не отмечено'],['cash','Наличные'],['transfer','Перевод'],['advance','Из аванса'],['debt','Долг / не оплачено']],choice)}</select></label><label class="field" data-amount-label${['cash','transfer'].includes(choice)?'':' hidden'}>Внесено, ₽<input data-field="paid" inputmode="decimal" value="${p.paidMinor?p.paidMinor/100:''}"></label></div>
    <label class="field" style="margin-top:10px">Оценка за урок<select data-field="score" data-original-score="${lessonScore(draft,p)??''}" ${st?'':'disabled'}>${options([['','Не выставлена'],...['1','2','3','4','5'].map(v=>[v,v])],String(participantScore(p)??''))}</select><small>Индивидуальная оценка ученика, отображается в расписании и учебной карточке.</small></label>
    <div class="fields reason-fields"><label class="field" data-reason-label${p.attendance==='absent'?'':' hidden'}>Причина отсутствия<select data-field="reason">${options([['','Выберите причину'],['illness','Болел'],['no_show','Не пришёл'],...(p.reason==='unspecified'?[['unspecified','Не уточняли (старая запись)']]:[])],p.reason||'')}</select></label><label class="field" data-paid-date-label${['cash','transfer'].includes(choice)?'':' hidden'}>Дата получения денег<input data-field="paidDate" type="date" value="${esc(p.paidDate||draft.date)}"></label><label class="field" data-moved-label${p.lessonStatus==='rescheduled'?'':' hidden'}>Новая дата<input data-field="movedToDate" type="date" value="${esc(p.movedToDate||'')}"></label><label class="field" data-moved-label${p.lessonStatus==='rescheduled'?'':' hidden'}>Новое время<input data-field="movedToTime" type="time" value="${esc(p.movedToTime||draft.time)}"></label></div>
    <label class="field" style="margin-top:10px" data-policy-label${p.attendance==='absent'||['rescheduled','teacher_cancelled'].includes(p.lessonStatus)?'':' hidden'}>Оплата при отсутствии / переносе<select data-field="missPolicy">${options([['','По настройке причины / сохранённому правилу'],['free','Не брать оплату'],['charge','Полная стоимость']],p.ruleOverride||'')}</select></label>
    ${row?.creditMinor?`<p class="hint">На этот урок ${row.actual?'списано':'зарезервировано'} из аванса: ${money(row.creditMinor)}.</p>`:''}
    </section>`;
  }).join('');
}
function captureParticipants(strict=false) {
  const ps=[];
  for (const card of $('participants').querySelectorAll('.participant')) {
    const i=Number(card.dataset.index), old=draft.participants[i], get=key=>card.querySelector(`[data-field="${key}"]`);
    const st=draft.isGroup?student(get('studentId').value):findStudent($('lessonLabel').value);
    if(strict&&!st)throw new Error(`Выберите ученика${draft.isGroup?' №'+(i+1):' из подсказки или создайте карточку'}.`);
    let priceMinor=null;
    try {priceMinor=toMinor(get('price').value);}catch(e){if(strict)throw new Error(`Укажите цену в карточке ученика ${i+1}.`);}
    const choice=get('choice').value;
    let paidMinor=0;
    if(['cash','transfer'].includes(choice)) { try{paidMinor=toMinor(get('paid').value);}catch(e){if(strict)throw new Error(`Укажите внесённую сумму для ученика ${i+1}.`);} }
    if(strict&&['cash','transfer'].includes(choice)&&paidMinor<=0)throw new Error('Для оплаты укажите сумму больше нуля. Если оплаты нет, выберите «Долг».');
    const attendanceChoice=get('attendance').value;
    const lessonStatus=attendanceChoice==='present'?'conducted':attendanceChoice==='absent'?'missed':attendanceChoice==='pending'?'scheduled':attendanceChoice;
    const attendance=['rescheduled','teacher_cancelled'].includes(lessonStatus)?'pending':attendanceChoice;
    const reason=attendance==='absent'?get('reason').value||null:null;
    if(strict&&attendance==='absent'&&!reason)throw new Error('Укажите причину отсутствия ученика.');
    const chosenSubject=studentSubjects(st).find(x=>x.id===get('subjectId').value);
    const subjectId=chosenSubject?.id||old.subjectId||null;
    const scoreInput=get('score');
    if(st&&scoreInput){const raw=scoreInput.value,score=raw===''?null:Number(raw);if(score!==null&&(!Number.isInteger(score)||score<1||score>5))throw new Error('Оценка за урок должна быть от 1 до 5.');const key=scoreDraftKey({studentId:st.id,subjectId,subject:chosenSubject?.subject||old.subject});if(raw!==scoreInput.dataset.originalScore)lessonScoreDrafts.set(key,{studentId:st.id,subjectId:lessonSubjectId({studentId:st.id,subjectId,subject:chosenSubject?.subject||old.subject}),score});else lessonScoreDrafts.delete(key);}
    const subject=subjectId===old.subjectId?(old.subject||chosenSubject?.subject||st?.subject||''):(chosenSubject?.subject||st?.subject||'');
    const paidDate=['cash','transfer'].includes(choice)?get('paidDate').value:null;
    if(strict&&['cash','transfer'].includes(choice)&&!paidDate)throw new Error('Укажите дату получения оплаты.');
    const movedToDate=lessonStatus==='rescheduled'?get('movedToDate').value||null:null;
    const movedToTime=lessonStatus==='rescheduled'?get('movedToTime').value||null:null;
    if(strict&&lessonStatus==='rescheduled'&&(!movedToDate||!movedToTime))throw new Error('Укажите новую дату и время переноса.');
    const ruleOverride=get('missPolicy').value||null;
    const current={...old,lessonStatus,attendance,reason};
    const sameReason=reasonKey(old)===reasonKey(current);
    const missPolicy=ruleOverride||(isActual(current)&&attendance!=='present'?(isActual(old)&&sameReason&&!old.ruleOverride?old.missPolicy:null)||reasonPolicy(state,current):null);
    ps.push({...old,studentId:st?.id||'',subjectId,subject,priceMinor,paidMinor,paidDate,movedToDate,movedToTime,method:choice==='transfer'?'transfer':'cash',attendance,lessonStatus,reason,missPolicy,ruleOverride,paymentConfirmed:!!choice,settlement:choice});
  }
  if(strict&&new Set(ps.map(p=>p.studentId)).size!==ps.length)throw new Error('Один ученик не может дважды входить в одну группу.');
  return ps;
}
$('lessonLabel').addEventListener('input',()=>{
  const value=$('lessonLabel').value;
  if(!draft.isGroup&&/группа/i.test(value)) { $('groupCount').value=2;$('countError').textContent='';show('countDialog');return; }
  if(!draft.isGroup) { const st=findStudent(value); if(st&&draft.participants[0].studentId!==st.id){draft.participants=[blankParticipant(st.id)];draft.participants[0].priceMinor=st.priceMinor;draft.participants[0].subjectId=studentSubjects(st)[0].id;draft.participants[0].subject=st.subject;renderParticipants();} }
});
$('changeCount').onclick=()=>{draft.participants=captureParticipants();$('groupCount').value=draft.participants.length;$('countError').textContent='';show('countDialog');};
$('countForm').onsubmit=e=>{
  e.preventDefault();const n=Number($('groupCount').value);
  if(!Number.isInteger(n)||n<2||n>15)return;
  if(n<draft.participants.length&&draft.participants.slice(n).some(p=>p.studentId||p.paidMinor||isActual(p))) { $('countError').textContent='В удаляемых строках уже есть данные. Уменьшить группу можно, пока эти строки пустые.';return; }
  draft.participants=captureParticipants();draft.isGroup=true;
  while(draft.participants.length<n)draft.participants.push(blankParticipant());
  draft.participants.length=n;
  if(!/группа/i.test($('lessonLabel').value))$('lessonLabel').value='Группа';
  close('countDialog');renderParticipants();$('participants').querySelector('select')?.focus();
};
$('participants').addEventListener('click',e=>{const edit=e.target.closest('[data-open-student]');if(edit){draft.participants=captureParticipants();newStudentTarget=null;const p=draft.participants[Number(edit.dataset.openStudent)];if(state.lessons.some(l=>l.id===draft.id))openStudentLesson(draft.id,p.studentId);else openStudent(p.studentId);return;}const b=e.target.closest('[data-new-student]');if(b){draft.participants=captureParticipants();newStudentTarget=Number(b.dataset.newStudent);openStudent();}});
$('participants').addEventListener('change',e=>{
  const card=e.target.closest('.participant');if(!card)return;
  const get=k=>card.querySelector(`[data-field="${k}"]`);
  if(e.target.dataset.field==='studentId') {
    const st=student(get('studentId').value);if(st){const first=studentSubjects(st)[0];get('price').value=first.priceMinor/100;const index=Number(card.dataset.index);draft.participants[index]={...draft.participants[index],subjectId:first.id,subject:first.subject};get('subjectId').innerHTML=options(studentSubjects(st).map(x=>[x.id,x.subject]),first.id);get('score').value=String(lessonScore(draft,{studentId:st.id,subjectId:first.id})??'');get('score').dataset.originalScore=get('score').value;}
    draft.participants=captureParticipants();renderParticipants();if(!editingWasComplete&&draft.isGroup&&completeGroup(draft))saveLesson(true);return;
  }
  if(e.target.dataset.field==='choice') {
    const choice=get('choice').value;
    if(['cash','transfer'].includes(choice)&&!draft.participants[Number(card.dataset.index)].paidMinor)get('paidDate').value=isoDate(new Date());
    card.querySelector('[data-amount-label]').hidden=!['cash','transfer'].includes(choice);
    if(['cash','transfer'].includes(choice)&&!get('paid').value)get('paid').value=get('price').value;
  }
  if(e.target.dataset.field==='subjectId'){const subject=studentSubjects(student(draft.participants[Number(card.dataset.index)].studentId)).find(x=>x.id===get('subjectId').value);if(subject){get('price').value=subject.priceMinor/100;draft.participants[Number(card.dataset.index)].subjectId=subject.id;draft.participants[Number(card.dataset.index)].subject=subject.subject;const score=participantScore(draft.participants[Number(card.dataset.index)]);get('score').value=String(score??'');get('score').dataset.originalScore=String(lessonScore(draft,draft.participants[Number(card.dataset.index)])??'');}}
  const mark=get('attendance').value;
  card.querySelector('[data-reason-label]').hidden=mark!=='absent';
  card.querySelector('[data-paid-date-label]').hidden=!['cash','transfer'].includes(get('choice').value);
  card.querySelectorAll('[data-moved-label]').forEach(el=>el.hidden=mark!=='rescheduled');
  card.querySelector('[data-policy-label]').hidden=!['absent','rescheduled','teacher_cancelled'].includes(mark);
  draft.participants=captureParticipants();
  if(!editingWasComplete&&draft.isGroup&&completeGroup(draft)) saveLesson(true);
});
function saveLesson(automatic=false) {
  if(autoClosing)return;
  $('lessonError').textContent='';
  const before=clone(state);
  try {
    if(!$('lessonForm').reportValidity())return;
    const ps=captureParticipants(true);
    const updated={...draft,date:$('lessonDate').value,time:$('lessonTime').value,durationMinutes:Number($('lessonDuration').value),label:draft.isGroup?$('lessonLabel').value.trim():'',participants:ps};
    if(updated.replacementOf){const original=state.lessons.find(l=>l.id===updated.replacementOf);if(!original||original.participants[0].attendance!=='absent')throw new Error('Исходное занятие больше не отмечено как пропущенное. Проверьте замену.');if(updated.participants.some(p=>original.participants.some(o=>o.studentId===p.studentId)))throw new Error('Для замены выберите другого ученика. Исходную запись можно отредактировать отдельно.');}
    if(!updated.label&&updated.isGroup)updated.label='Группа';
    if(updated.isGroup&&!ps.every(p=>p.studentId))throw new Error('Выберите всех учеников.');
    const old=state.lessons.find(l=>l.id===updated.id);
    if(old&&old.date!==updated.date&&old.seriesId)state.exclusions.push(`${old.seriesId}:${old.date}`);
    if(old)state.lessons[state.lessons.indexOf(old)]=updated;else state.lessons.push(updated);
    syncRescheduledLessons(updated,old);
    syncSeries(state,updated,$('repeatLesson').checked);
    if($('repeatLesson').checked) ensureWeek(state,addDays(mondayOf(updated.date),7));
    materialize(mondayOf(updated.date));
    let led=ledger(state);
    for(const p of ps)if(p.settlement==='advance'&&chargeFor(state,p)>0&&!(led.rows.get(`${updated.id}:${p.studentId}`)?.creditMinor))throw new Error(`У ${student(p.studentId).name} нет свободного аванса на этот урок. Внесите аванс или выберите «Долг».`);
    if(completeGroup(updated))updated.collapsed=true;
    for(const p of ps){const change=lessonScoreDrafts.get(scoreDraftKey(p));if(change)saveStudentLessonScore(state,change.studentId,updated.id,change.subjectId,change.score);}
    validateState(state);
    if(!persist())throw new Error('Данные не сохранены в браузере. Скачайте резервную копию.');
    autoClosing=true;selectedPage=weekday(updated.date)>=3?1:0;week=mondayOf(updated.date);close('lessonDialog');render();
    toast(automatic?'Все ученики заполнены — группа сохранена и свёрнута':'Занятие сохранено'+($('repeatLesson').checked?' · повторяется каждую неделю':''));
  }catch(e){state=before;$('lessonError').textContent=e.message;}
}
function openReplacement(sourceId){
  try{const replacement=replacementDraft(state,sourceId);openLesson(null,replacement.date);draft=replacement;editingWasComplete=false;$('lessonTitle').textContent='Другой ученик на это время';$('lessonTime').value=draft.time;$('lessonDuration').value=draft.durationMinutes;$('repeatLesson').checked=false;$('replacementNotice').hidden=false;$('replacementNotice').textContent='Исходный пропуск остаётся в истории. Выберите другого ученика: дата, время и длительность уже подставлены. По умолчанию это разовое занятие.';$('replaceLesson').hidden=true;renderParticipants();$('lessonLabel').focus();}catch(e){toast(e.message);}
}
$('replaceLesson').onclick=()=>{const sourceId=draft.id;if(confirm('Добавить другого ученика на это время? Несохранённые изменения текущей формы не будут применены.'))openReplacement(sourceId);};
$('lessonForm').onsubmit=e=>{e.preventDefault();saveLesson();};
$('removeLesson').onclick=()=>{
  if(!confirm('Убрать только это занятие? Его отметки и разовая оплата также будут убраны. Остальные недели и полученные авансы сохранятся.'))return;
  const before=clone(state);const l=state.lessons.find(l=>l.id===draft.id);
  if(state.lessons.some(x=>x.replacementOf===l.id||x.rescheduledFrom?.lessonId===l.id||x.participants.some(p=>p.rescheduledToId===l.id))){$('lessonError').textContent='Занятие связано с заменой или переносом. Сначала проверьте связанную запись, чтобы сохранить историю.';return;}
  if(l.seriesId)state.exclusions.push(`${l.seriesId}:${l.date}`);
  state.lessons=state.lessons.filter(x=>x.id!==l.id);if(!persist()){state=before;$('lessonError').textContent='Удаление не сохранено.';return;}close('lessonDialog');render();toast('Занятие убрано. Остаток аванса пересчитан.');
};
function advancePreview() {
  const st=student($('advanceStudent').value);let amount;
  try{amount=toMinor($('advanceAmount').value);}catch{amount=0;}
  if(!st||!amount){$('advancePreview').textContent='Выберите ученика и введите сумму.';return;}
  const price=st.priceMinor;
  if(!price){$('advancePreview').textContent='Аванс сохранится на балансе. Укажите ненулевую цену урока для распределения.';return;}
  const full=Math.floor(amount/price), tail=amount%price;
  $('advancePreview').textContent=`По цене ${money(price)}: ${full?full+' полн. '+(full===1?'урок':'урока')+' × '+money(price):''}${full&&tail?' + ':''}${tail?'остаток '+money(tail)+' на последнем уроке':''}.\nФактическое распределение учитывает цены отдельных занятий и уже внесённые оплаты.`;
}
function renderAdvances() {
  const led=ledger(state);
  $('advanceList').innerHTML=state.advances.length?[...state.advances].reverse().map(a=>{
    const c=led.credits.get(a.id);
    return `<details class="credit-item"><summary>${esc(student(a.studentId)?.name)} · ${money(a.amountMinor)} · с ${formatDate(a.startDate)}<span class="sub">Остаток: ${money(a.amountMinor-c.spentMinor)} · из него зарезервировано: ${money(c.reservedMinor)}</span></summary><div class="credit-details">${c.allocations.map(x=>`${formatDate(x.date)} — ${money(x.amountMinor)} (${x.actual?'списано':'резерв'})`).join('<br>')||'Пока нет подходящих занятий.'}${c.remainingMinor?'<br>Ещё не распределено: '+money(c.remainingMinor):''}</div><button type="button" class="link" data-edit-advance="${esc(a.id)}">Исправить аванс</button></details>`;
  }).join(''):'<p class="hint">Пока нет авансов.</p>';
}
let editingAdvanceId=null;
function openAdvance() {
  editingAdvanceId=null;$('saveAdvance').textContent='Внести аванс';
  $('advanceStudent').innerHTML=options([['','Выберите ученика'],...state.students.map(s=>[s.id,studentText(s)])],state.students.length===1?state.students[0].id:'');
  $('advanceAmount').value='';$('advanceStart').value=isoDate(new Date());$('advanceReceived').value=isoDate(new Date());$('advanceError').textContent='';
  renderAdvances();advancePreview();show('advanceDialog');
}
$('advanceBtn').onclick=()=>{if(!state.students.length){toast('Сначала добавьте ученика');newStudentTarget=null;openStudent();return;}openAdvance();};
for(const id of ['advanceStudent','advanceAmount','advanceStart'])$(id).addEventListener('input',advancePreview);
$('advanceList').onclick=e=>{
  const b=e.target.closest('[data-edit-advance]');if(!b)return;
  const a=state.advances.find(a=>a.id===b.dataset.editAdvance);editingAdvanceId=a.id;
  $('advanceStudent').value=a.studentId;$('advanceAmount').value=a.amountMinor/100;$('advanceStart').value=a.startDate;$('advanceReceived').value=a.receivedDate||a.startDate;
  $('saveAdvance').textContent='Сохранить исправление';advancePreview();$('advanceAmount').focus();
};
$('advanceForm').onsubmit=e=>{
  e.preventDefault();$('advanceError').textContent='';const before=clone(state);
  try{
    const amountMinor=toMinor($('advanceAmount').value);if(!amountMinor)throw new Error('Аванс должен быть больше нуля.');
    const data={id:editingAdvanceId||crypto.randomUUID(),studentId:$('advanceStudent').value,amountMinor,startDate:$('advanceStart').value,receivedDate:$('advanceReceived').value,createdAt:state.advances.find(a=>a.id===editingAdvanceId)?.createdAt||new Date().toISOString()};
    if(!student(data.studentId))throw new Error('Выберите ученика.');
    const old=state.advances.find(a=>a.id===editingAdvanceId);if(old)Object.assign(old,data);else state.advances.push(data);
    materialize();if(!persist())throw new Error('Не удалось сохранить аванс.');
    close('advanceDialog');render();toast(editingAdvanceId?'Аванс исправлен, распределение пересчитано':'Аванс распределён по следующим занятиям');
  }catch(e){state=before;$('advanceError').textContent=e.message;}
};
$('settingsBtn').onclick=()=>{
  $('missPolicy').value=state.settings.missPolicy;
  for(const [id,key] of Object.entries({policyIllness:'illness',policyNoShow:'no_show',policyRescheduled:'rescheduled',policyTeacher:'teacher_cancelled'}))$(id).value=state.settings.reasonRules[key];
  $('settingsError').textContent='';show('settingsDialog');
};
$('settingsForm').onsubmit=e=>{
  e.preventDefault();const old=clone(state.settings);
  state.settings.missPolicy=$('missPolicy').value;
  state.settings.reasonRules={illness:$('policyIllness').value,no_show:$('policyNoShow').value,rescheduled:$('policyRescheduled').value,teacher_cancelled:$('policyTeacher').value,unspecified:$('missPolicy').value};
  if(!persist()){state.settings=old;$('settingsError').textContent='Не удалось сохранить правила.';return;}
  close('settingsDialog');render();toast('Правила сохранены. Прошлые отмеченные занятия не изменены.');
};
function download(content,name) {const url=URL.createObjectURL(new Blob([content],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('exportData').onclick=()=>{const content=JSON.stringify(state,null,2);download(content,`repetjournal-${isoDate(new Date())}.json`);};
$('importData').onclick=()=>$('importFile').click();
$('importFile').onchange=async()=>{
  const f=$('importFile').files[0];if(!f)return;
  try{
    if(f.size>10000000)throw new Error('Файл слишком большой (максимум 10 МБ).');
    const data=validateState(upgradeState(JSON.parse(await f.text())));
    if(!confirm('Заменить текущий дневник данными из копии? Перед заменой скачайте текущую копию.'))return;
    const previous=state,wasBlocked=blockedStorage;state=data;blockedStorage=false;
    if(!persist()){state=previous;blockedStorage=wasBlocked;throw new Error('Загрузка не сохранена: проверьте свободное место в браузере.');}
    $('storageAlert').hidden=true;close('settingsDialog');render();toast('Резервная копия загружена');
  }catch(e){$('settingsError').textContent=`Не удалось загрузить: ${e.message}`;}finally{$('importFile').value='';}
};
let paperAudio;
function paperSound() {
  try {
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio)return;
    paperAudio ||= new Audio();
    paperAudio.resume().then(()=>{
      const seconds=.42, buffer=paperAudio.createBuffer(1,Math.ceil(paperAudio.sampleRate*seconds),paperAudio.sampleRate);
      const data=buffer.getChannelData(0);
      for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*Math.sin(Math.PI*i/data.length);
      const noise=paperAudio.createBufferSource(), filter=paperAudio.createBiquadFilter(), gain=paperAudio.createGain();
      noise.buffer=buffer;filter.type='bandpass';filter.frequency.value=1700;filter.Q.value=.65;gain.gain.value=.14;
      noise.connect(filter).connect(gain).connect(paperAudio.destination);noise.start();
    }).catch(()=>{});
  } catch {}
}
function changeWeek(target) {
  if(target===week)return;
  const forward=target>week, book=document.querySelector('.book');
  book.querySelectorAll('.turn-sheet').forEach(el=>el.remove());
  const portrait=window.matchMedia('(orientation: portrait)').matches;
  const source=portrait?$(selectedPage?'page2':'page1'):$(forward?'page2':'page1');
  const sheet=document.createElement('div');sheet.className='turn-sheet '+(forward?'forward':'backward');sheet.setAttribute('aria-hidden','true');sheet.inert=true;
  const copy=source.cloneNode(true);copy.removeAttribute('id');copy.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));sheet.append(copy);
  week=target;render();
  book.append(sheet);paperSound();
  sheet.addEventListener('animationend',()=>sheet.remove(),{once:true});setTimeout(()=>sheet.remove(),750);
}
$('prev').onclick=()=>changeWeek(addDays(week,-7));
$('next').onclick=()=>changeWeek(addDays(week,7));
$('today').onclick=()=>{selectedPage=weekday(isoDate(new Date()))>=3?1:0;changeWeek(mondayOf(isoDate(new Date())));showDiaryPage(selectedPage);};
$('datePick').onchange=()=>{if($('datePick').value){selectedPage=weekday($('datePick').value)>=3?1:0;changeWeek(mondayOf($('datePick').value));showDiaryPage(selectedPage);}};
$('addTop').onclick=()=>openLesson(null,week===mondayOf(isoDate(new Date()))?isoDate(new Date()):week);
let studentTab='profile', primarySubjectId=null;
function subjectOptions(st,p){const choices=studentSubjects(st).map(s=>[s.id,s.subject]);if(p.subjectId&&!choices.some(x=>x[0]===p.subjectId))choices.unshift([p.subjectId,(p.subject||'Сохранённый предмет')+' · из истории']);return choices;}
function renderStudents(){
  const led=ledger(state);
  $('studentList').innerHTML=state.students.length?state.students.map(st=>{
    const debt=state.lessons.reduce((sum,l)=>{const p=l.participants.find(p=>p.studentId===st.id),row=p&&led.rows.get(`${l.id}:${st.id}`);return sum+(row?.actual?row.dueMinor:0);},0);
    const balance=[...led.credits.values()].filter(a=>a.studentId===st.id).reduce((sum,a)=>sum+a.amountMinor-a.spentMinor,0);
    return `<article class="list-card"><div><h3>${esc(st.name)}${st.status==='archived'?' · архив':''}</h3><p>${esc(studentSubjects(st).map(s=>s.subject+' · '+money(s.priceMinor)).join(' / '))}${st.grade?' · '+esc(st.grade):''}</p><p>Долг: ${money(debt)} · Аванс: ${money(balance)}</p></div><div class="person-actions"><button type="button" data-edit-student="${esc(st.id)}">Карточка</button><button type="button" data-report-student="${esc(st.id)}">Отчёты</button></div></article>`;
  }).join(''):'<div class="empty-state">Добавьте ученика: предмет и стоимость будут подставляться из его карточки.</div>';
}
$('cardsBtn').onclick=()=>{renderStudents();show('studentsDialog');};
$('newStudent').onclick=()=>{newStudentTarget=null;openStudent();};
$('studentList').onclick=e=>{const b=e.target.closest('[data-edit-student],[data-report-student]');if(!b)return;newStudentTarget=null;openStudent(b.dataset.editStudent||b.dataset.reportStudent,b.dataset.reportStudent?'lessons':'profile');};
function addSubjectRow(value={id:crypto.randomUUID(),subject:'',priceMinor:null}){
  if($('extraSubjects').children.length>=19){$('studentError').textContent='Не более 20 предметов в карточке.';return;}
  const el=document.createElement('section');el.className='subject-card';el.dataset.subjectId=value.id;
  el.innerHTML=`<div class="mini-head"><b>Дополнительный предмет</b><button type="button" class="link" data-remove-subject>Убрать</button></div><div class="fields"><label class="field">Предмет<input data-subject-name maxlength="100" list="subjectNames" value="${esc(value.subject)}"></label><label class="field">Цена за урок, ₽<input data-subject-price inputmode="decimal" value="${value.priceMinor===null?'':value.priceMinor/100}"></label></div>`;
  $('extraSubjects').append(el);
}
function addParentRow(value={id:crypto.randomUUID(),name:'',relationship:'Родитель',phone:'',messenger:''}){
  if($('parentContacts').children.length>=10){$('studentError').textContent='Не более 10 представителей.';return;}
  const el=document.createElement('section');el.className='contact-card';el.dataset.parentId=value.id;
  el.innerHTML=`<div class="mini-head"><b>Родитель / представитель</b><button type="button" class="link" data-remove-parent>Убрать</button></div><div class="fields"><label class="field">Имя<input data-parent-field="name" maxlength="100" value="${esc(value.name)}"></label><label class="field">Кем приходится<input data-parent-field="relationship" maxlength="60" value="${esc(value.relationship)}"></label><label class="field">Телефон<input type="tel" data-parent-field="phone" maxlength="100" value="${esc(value.phone)}"></label><label class="field">Мессенджер<input data-parent-field="messenger" maxlength="100" value="${esc(value.messenger)}"></label></div>`;
  $('parentContacts').append(el);
}
$('addSubject').onclick=()=>addSubjectRow();$('addParent').onclick=()=>addParentRow();
$('extraSubjects').onclick=e=>{if(e.target.closest('[data-remove-subject]'))e.target.closest('.subject-card').remove();};
$('parentContacts').onclick=e=>{if(e.target.closest('[data-remove-parent]'))e.target.closest('.contact-card').remove();};
function openStudent(id,tab='profile'){
  editingStudentId=id||null;const st=student(id),primary=studentSubjects(st)[0];primarySubjectId=primary?.id||crypto.randomUUID();
  $('studentTitle').textContent=st?`Карточка · ${st.name}`:'Новый ученик';$('studentName').value=st?.name||'';
  $('studentSubject').value=primary?.subject||state.students.at(-1)?.subject||'';$('studentPrice').value=primary?primary.priceMinor/100:'';
  $('studentGrade').value=st?.grade||'';$('studentStatus').value=st?.status||'active';$('studentComment').value=st?.comment||'';
  $('studentChildPhone').value=st?.childPhone||'';$('studentChildMessenger').value=st?.childMessenger||'';
  $('studentContact').value=st?.contact||'';$('legacyContactField').hidden=!st?.contact;
  $('extraSubjects').replaceChildren();for(const subject of studentSubjects(st).slice(1))addSubjectRow(subject);
  $('parentContacts').replaceChildren();for(const parent of st?.parents||[])addParentRow(parent);
  $('studentError').textContent='';$('tabLessons').disabled=!st;$('tabPayments').disabled=!st;$('studentAdvance').hidden=!st;
  if(!$('reportFrom').value)$('reportFrom').value=week.slice(0,8)+'01';if(!$('reportTo').value)$('reportTo').value=addDays(week,6);
  setStudentTab(st?tab:'profile');show('studentDialog');
}
function setStudentTab(tab){
  studentTab=tab;$('studentProfile').hidden=tab!=='profile';$('studentReport').hidden=tab==='profile';$('saveStudent').hidden=tab!=='profile';$('studentError').textContent='';
  for(const b of document.querySelectorAll('[data-student-tab]')){const active=b.dataset.studentTab===tab;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;}
  if(tab!=='profile')renderStudentReport();
}
for(const b of document.querySelectorAll('[data-student-tab]'))b.onclick=()=>setStudentTab(b.dataset.studentTab);
document.querySelector('.card-tabs').addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();
  const buttons=[...document.querySelectorAll('[data-student-tab]')].filter(b=>!b.disabled),i=buttons.indexOf(document.activeElement);
  const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
  buttons[next].focus();setStudentTab(buttons[next].dataset.studentTab);
});
$('studentForm').onsubmit=e=>{
  e.preventDefault();if(studentTab!=='profile'){renderStudentReport();return;}
  const before=clone(state);$('studentError').textContent='';
  try {
    const subjects=[{id:primarySubjectId,subject:$('studentSubject').value.trim(),priceMinor:toMinor($('studentPrice').value)},...[...$('extraSubjects').children].map(row=>({id:row.dataset.subjectId,subject:row.querySelector('[data-subject-name]').value.trim(),priceMinor:toMinor(row.querySelector('[data-subject-price]').value)}))];
    if(subjects.some(s=>!s.subject))throw new Error('Для каждого предмета укажите название и стоимость.');
    if(new Set(subjects.map(s=>s.subject.toLowerCase())).size!==subjects.length)throw new Error('Предметы в одной карточке не должны повторяться.');
    const parents=[...$('parentContacts').children].map(row=>({id:row.dataset.parentId,...Object.fromEntries([...row.querySelectorAll('[data-parent-field]')].map(input=>[input.dataset.parentField,input.value.trim()]))})).filter(p=>p.name||p.phone||p.messenger);
    const data={id:editingStudentId||crypto.randomUUID(),name:$('studentName').value.trim(),subject:subjects[0].subject,priceMinor:subjects[0].priceMinor,subjects,contact:$('studentContact').value.trim(),childPhone:$('studentChildPhone').value.trim(),childMessenger:$('studentChildMessenger').value.trim(),parents,grade:$('studentGrade').value.trim(),status:$('studentStatus').value,comment:$('studentComment').value.trim()};
    if(!data.name)throw new Error('Укажите имя ученика.');
    if(state.students.some(s=>s.id!==data.id&&s.name.toLocaleLowerCase('ru')===data.name.toLocaleLowerCase('ru')&&s.subject.toLocaleLowerCase('ru')===data.subject.toLocaleLowerCase('ru')))throw new Error('Такая карточка уже есть в списке.');
    const existing=student(data.id);if(existing)Object.assign(existing,data);else state.students.push(data);
    validateState(state);if(!persist())throw new Error('Не удалось сохранить карточку.');
    close('studentDialog');render();renderStudents();
    if($('lessonDialog').open&&newStudentTarget!==null){const p={...blankParticipant(data.id),priceMinor:data.priceMinor,subjectId:data.subjects[0].id,subject:data.subject};draft.participants[newStudentTarget]=p;if(!draft.isGroup)$('lessonLabel').value=studentText(data);renderParticipants();}
    newStudentTarget=null;toast('Карточка сохранена. Отчёты — во вкладках «Занятия» и «Оплаты».');
  }catch(error){state=before;$('studentError').textContent=error.message;}
};
$('studentAdvance').onclick=()=>{if(!editingStudentId)return;openAdvance();$('advanceStudent').value=editingStudentId;advancePreview();};
function reportKpi(label,value){return `<div class="report-kpi"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;}
function currentReport(){return studentReport(state,editingStudentId,$('reportFrom').value,$('reportTo').value);}
function renderStudentReport(){
  try {
    const r=currentReport();$('studentError').textContent='';$('reportPrint').disabled=false;$('reportShare').disabled=false;
    if(studentTab==='lessons'){
      $('reportContent').innerHTML=`<h3>Посещаемость · ${esc(student(editingStudentId).name)}</h3><div class="report-kpis">${reportKpi('Посещений',r.counts.present)+reportKpi('Пропусков ученика',r.counts.absent)+reportKpi('Переносов',r.counts.rescheduled)+reportKpi('Отмен преподавателем',r.counts.teacherCancelled)+reportKpi('Не отмечено',r.counts.pending)}</div>${r.visits.length?`<div class="report-scroll"><table class="report-table"><thead><tr><th>Дата / время</th><th>Предмет</th><th>Посещаемость / статус</th><th>Причина / перенос</th><th>Начислено</th></tr></thead><tbody>${r.visits.map(v=>`<tr><td>${esc(formatDate(v.date))}<br>${esc(v.time)}</td><td>${esc(v.subject)}</td><td>${esc(v.status)}</td><td>${esc(v.reason)}${v.movedToDate?`<br>→ ${esc(formatDate(v.movedToDate))} ${esc(v.movedToTime)}`:''}</td><td>${v.financialActual?money(v.amountMinor):'—'}${v.policy?'<br><small>'+esc(v.policy==='free'?'Без оплаты':'Полная стоимость')+'</small>':''}</td></tr>`).join('')}</tbody></table></div>`:'<p class="empty-report">За выбранный период занятий нет.</p>'}<p class="hint">Переносы и отмены преподавателем не входят в пропуски ученика. Начисление учитывает сохранённое правило конкретного занятия.</p>`;
    }else{
      $('reportContent').innerHTML=`<h3>Оплаты · ${esc(student(editingStudentId).name)}</h3><div class="report-kpis">${reportKpi('Поступило денег',money(r.receivedMinor))+reportKpi('Из них получено авансом',money(r.advanceReceivedMinor))+reportKpi('Списано из аванса',money(r.advanceSpentMinor))+reportKpi('Начислено за отмеченные уроки',money(r.chargedMinor))+reportKpi('Долг уроков периода на '+r.to,money(r.debtMinor))+reportKpi('Аванс на начало периода',money(r.openingAdvanceMinor))+reportKpi('Аванс на конец периода',money(r.endingAdvanceMinor))}${r.overpaidMinor?reportKpi('Переплата · требует проверки',money(r.overpaidMinor)):''}</div>${r.operations.length?`<div class="report-scroll"><table class="report-table"><thead><tr><th>Дата</th><th>Операция</th><th>Получено</th><th>Списано аванса</th><th>Пояснение</th></tr></thead><tbody>${r.operations.map(v=>`<tr><td>${esc(formatDate(v.date))}${v.assumedDate?' *':''}</td><td>${esc(v.type)}</td><td>${v.incomingMinor?money(v.incomingMinor):'—'}</td><td>${v.spentMinor?money(v.spentMinor):'—'}</td><td>${esc(v.description)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="empty-report">За выбранный период операций нет.</p>'}<p class="hint">Получение аванса и его расход показаны отдельно: расход не увеличивает сумму поступлений. Будущие резервы не считаются расходом.</p>${r.hasAssumedDates?'<p class="notice">* В старых записях дата получения не указана: использована дата урока или начала аванса. Её можно уточнить в занятии / авансе.</p>':''}<p class="hint">Долг относится к отмеченным занятиям выбранного периода и рассчитан на его конец. Это локальный отчёт по текущим записям, без неизменяемого бухгалтерского журнала.</p>`;
    }
  }catch(error){$('reportContent').innerHTML='<p class="empty-report">Проверьте даты периода.</p>';$('studentError').textContent=error.message;$('reportPrint').disabled=true;$('reportShare').disabled=true;}
}
for(const id of ['reportFrom','reportTo'])$(id).onchange=renderStudentReport;
function textForCurrentReport(){return reportText(state,editingStudentId,$('reportFrom').value,$('reportTo').value,studentTab);}
$('reportPrint').onclick=()=>{
  try{const text=textForCurrentReport();$('printReport').textContent=text;document.body.classList.add('printing-report');window.print();}catch(error){document.body.classList.remove('printing-report');$('studentError').textContent='Откройте дневник в обычном браузере для печати. '+error.message;}
};
window.addEventListener('afterprint',()=>document.body.classList.remove('printing-report'));
$('reportShare').onclick=async()=>{
  try{const text=textForCurrentReport();if(navigator.share){try{await navigator.share({title:studentTab==='payments'?'Отчёт об оплатах':'Отчёт о посещаемости',text});return;}catch(error){if(error.name==='AbortError')return;}}
    $('shareReportText').value=text;$('shareStatus').textContent='Выберите «Скопировать» или выделите текст вручную.';show('shareDialog');
  }catch(error){$('studentError').textContent=error.message;}
};
$('copyReport').onclick=async()=>{
  try{await navigator.clipboard.writeText($('shareReportText').value);$('shareStatus').textContent='Скопировано. Вставьте отчёт в нужный мессенджер.';}catch{$('shareReportText').focus();$('shareReportText').select();$('shareReportText').setSelectionRange(0,$('shareReportText').value.length);$('shareStatus').textContent='Копирование заблокировано браузером. Текст выделен — скопируйте вручную.';}
};
const tutorFields={name:'tutorName',phone:'tutorPhone',messenger:'tutorMessenger',email:'tutorEmail',city:'tutorCity',subjects:'tutorSubjects',grades:'tutorGrades',education:'tutorEducation',experience:'tutorExperience',availability:'tutorAvailability',bio:'tutorBio',format:'tutorFormat',freeSlots:'tutorFreeSlots'};
$('tutorBtn').onclick=()=>{for(const [key,id] of Object.entries(tutorFields))$(id).value=state.tutor[key]??'';$('tutorError').textContent='';show('tutorDialog');loadTutorAccess();};
$('tutorForm').onsubmit=e=>{
  e.preventDefault();const before=clone(state);
  try{state.tutor=Object.fromEntries(Object.entries(tutorFields).map(([key,id])=>[key,key==='freeSlots'?Number($(id).value):$(id).value.trim()]));if(!state.tutor.name)throw new Error('Укажите имя преподавателя.');validateState(state);if(!persist())throw new Error('Не удалось сохранить анкету.');close('tutorDialog');toast('Анкета преподавателя сохранена в этом дневнике.');}catch(error){state=before;$('tutorError').textContent=error.message;}
};
function syncRescheduledLessons(updated,old){
  if(old?.participants.some(p=>p.rescheduledToId&&!updated.participants.some(n=>n.studentId===p.studentId)))throw new Error('У удаляемого участника есть перенос. Сначала проверьте связанную запись.');
  for(const p of updated.participants){
    const prior=old?.participants.find(x=>x.studentId===p.studentId),target=state.lessons.find(l=>l.id===(p.rescheduledToId||prior?.rescheduledToId));
    if(p.lessonStatus!=='rescheduled'){
      if(target){if(target.seriesId||target.participants.some(x=>isActual(x)||x.paidMinor||x.paymentConfirmed))throw new Error('В перенесённом занятии уже есть отметки или повторение. Сохраните связь переноса.');state.lessons=state.lessons.filter(l=>l.id!==target.id);}
      p.rescheduledToId=null;continue;
    }
    if(p.movedToDate===updated.date&&p.movedToTime===updated.time)throw new Error('При переносе выберите другое время или дату.');
    if(target){
      if(target.date!==p.movedToDate||target.time!==p.movedToTime){if(target.seriesId||target.participants.some(x=>isActual(x)||x.paidMinor||x.paymentConfirmed))throw new Error('Перенесённый урок уже заполнен. Сначала проверьте его запись.');target.date=p.movedToDate;target.time=p.movedToTime;}
      p.rescheduledToId=target.id;
    }else{
      const newLesson={id:crypto.randomUUID(),seriesId:null,date:p.movedToDate,time:p.movedToTime,durationMinutes:updated.durationMinutes??60,label:'',isGroup:false,collapsed:false,rescheduledFrom:{lessonId:updated.id,studentId:p.studentId},participants:[{...blankParticipant(p.studentId),priceMinor:p.priceMinor,subjectId:p.subjectId,subject:p.subject}]};
      state.lessons.push(newLesson);p.rescheduledToId=newLesson.id;
    }
  }
}

async function loadTutorAccess(){
 $('tutorAccess').textContent='Создайте свой дневник, чтобы сохранять расписание и вести собственных учеников.';
}
$('tutorAccessReload').onclick=loadTutorAccess;

/* Student subject page: real timetable and teacher-owned learning notes. */
const worldArt={"chemistry":"/demo/portrait-1.webp","biology":"/demo/portrait-2.webp","math": "/demo/portrait-3.webp", "english": "/demo/portrait-4.webp", "russian": "/demo/portrait-5.webp", "french": "/demo/portrait-6.webp"};
let worldStudentId=null,worldSubjectId=null,worldSection='lessons';
const worldDialog=document.createElement('dialog');worldDialog.id='learningWorld';
worldDialog.innerHTML=`<div class="world-layout"><aside class="world-portrait"><div class="world-person"><h2></h2><p></p></div></aside><main class="world-main"><div class="world-header"><div class="world-top"><button type="button" data-world-close aria-label="Закрыть учебную страницу">×</button></div><p class="world-season">ОСЕНЬ · ЛИЧНАЯ СТРАНИЦА</p><h1>Карточка ученика</h1><h2 id="worldStudentName"></h2><p id="worldStudentMeta" class="world-student-meta"></p><div id="worldSubjects"></div><nav class="world-tabs"><button type="button" data-world-tab="lessons">Занятия</button><button type="button" data-world-tab="homework">Домашнее задание</button><button type="button" data-world-tab="progress">Прогресс ученика</button></nav></div><div id="worldContent"></div><div class="world-links"><button type="button" id="worldProfile">Данные ученика</button><button type="button" id="worldFinance">Оплаты и отчёт</button></div></main></div>`;
document.body.append(worldDialog);
const worldStyle=document.createElement('style');worldStyle.textContent=`
#learningWorld{width:min(1420px,calc(100vw - 24px));max-width:none;max-height:95dvh;padding:0;border:1px solid #ddcdb4;border-radius:14px;background:#fbf6ec;color:#223243}
.world-layout{display:grid;grid-template-columns:43% 57%;min-height:750px}.world-portrait{background-color:#ebd5b5;background-image:var(--portrait);background-size:cover;background-position:center top;position:relative;min-height:750px}.world-person{position:absolute;bottom:0;left:0;right:0;padding:45px 24px 20px;background:linear-gradient(transparent,#f3e3c9 60%);text-align:center}.world-person h2{font:30px Georgia,serif;color:#523c28;margin:15px 0 6px}.world-person p{font:14px Georgia,serif;color:#78573c}
.world-main{padding:22px 30px 28px;background:linear-gradient(120deg,#fffaf1,#f8efe1)}.world-top{display:flex;justify-content:space-between;align-items:center}.world-top b{font:23px Georgia,serif;color:#5d462f}.world-top button{font-size:25px;padding:0 8px;border:0;background:transparent}.world-season{font:10px Arial;letter-spacing:2px;color:#a26943;margin:24px 0 10px}.world-main h1{font:44px Georgia,serif;margin:0 0 10px;color:#233646}#worldStudentName{font:18px Georgia,serif;margin-bottom:18px}#worldSubjects{display:flex;gap:7px;flex-wrap:wrap}#worldSubjects button{border-radius:20px;font-size:12px;padding:7px 12px;background:#fcf8ef;border-color:#dfcbb0}#worldSubjects button[aria-pressed=true]{background:#89522f;color:white;border-color:#89522f}.world-tabs{display:flex;gap:12px;border-bottom:1px solid #ddccb3;margin:20px 0;flex-wrap:wrap}.world-tabs button{background:none;border:0;border-radius:0;padding:12px 0;font:15px Georgia,serif}.world-tabs button[aria-selected=true]{color:#96522c;border-bottom:2px solid #a65c2f}.world-card{padding:18px;border:1px solid #e3d4bf;background:#fffcf6;border-radius:11px;margin:12px 0;box-shadow:0 3px 12px #77502107}.world-card h3{font:22px Georgia,serif;margin:4px 0 10px;color:#283b4b}.world-card p{font-size:13px;line-height:1.5;white-space:pre-wrap}.world-meta{color:#89745d;font-size:12px}.world-card button{margin:5px 7px 0 0}.world-card .primary{background:#86502e}.world-links{display:flex;gap:8px;margin-top:24px;flex-wrap:wrap}.world-kpis{display:grid;grid-template-columns:1fr 1fr;gap:10px}.world-kpi{padding:16px;background:#f3e6d2;border-radius:10px}.world-kpi b{display:block;font:30px Georgia,serif;color:#58643b}.world-kpi span{font-size:12px}.world-editor{display:grid;gap:12px}.world-editor label{display:grid;gap:6px;font-size:13px}.world-editor input,.world-editor select,.world-editor textarea{width:100%;padding:10px;border:1px solid #d8c7ae;border-radius:6px;background:#fffcf6;font:14px Arial;color:#253645}.world-editor textarea{min-height:80px}.world-status{font-size:12px;color:#6b7144}.world-score-list{padding:0;list-style:none}.world-score-list li{display:flex;justify-content:space-between;border-bottom:1px solid #e2d7c7;padding:10px 0;font-size:13px}.world-note{font-size:12px;color:#81715f;line-height:1.5}
@media(min-width:761px){.world-portrait{position:sticky;top:0;align-self:start;height:95dvh;min-height:0;background-position:center center}}
@media(max-width:760px){#learningWorld{max-height:96dvh}.world-layout{grid-template-columns:1fr}.world-portrait{min-height:360px;background-size:cover;background-position:center 28%}.world-person{padding-top:25px}.world-person h2{font-size:24px}.world-main{padding:20px}.world-main h1{font-size:34px}.world-tabs{gap:10px}.world-tabs button{font-size:14px}}
@media print{.world-portrait,.world-top,.world-links,#worldSubjects,.world-tabs{display:none}.world-layout{display:block}}

.world-main{padding:16px 24px}.world-season{margin:10px 0 5px}.world-main h1{font-size:36px;margin-bottom:5px}#worldStudentName{margin:0 0 10px}#worldSubjects{gap:5px}#worldSubjects button{padding:4px 9px}.world-tabs{margin:10px 0}.world-tabs button{padding:8px 0}.world-overview .world-card{margin:8px 0;padding:12px}.world-feature{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:12px;align-items:center}.world-feature h3{font-size:20px;margin:4px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.world-feature p{margin:4px 0;font-size:12px}.world-feature button{font-size:12px;padding:5px 10px}.world-sketch{width:100%;max-height:100px}.world-chart-compact svg{height:120px!important;display:block}.world-chart-compact .world-score-list,.world-chart-compact .world-note{display:none}.world-chart-compact h3{font-size:18px;margin:0}.world-chart-compact p{margin:4px 0;font-size:11px!important}.world-history{margin-top:10px;font-size:12px}.world-history summary{cursor:pointer;color:#89522f}.world-links{margin-top:10px}.world-links button{padding:5px 9px;font-size:12px}.world-layout{min-height:0}.world-person h2{font-size:27px}
@media(max-width:1000px) and (min-width:761px){.world-main{padding:14px 18px}.world-main h1{font-size:30px}.world-season{font-size:9px}.world-feature{grid-template-columns:minmax(0,1fr) 85px;gap:8px}.world-feature h3{font-size:17px}.world-chart-compact svg{height:100px!important}.world-top b{font-size:19px}}
@media(max-width:760px){.world-feature{grid-template-columns:minmax(0,1fr) 90px}.world-main{padding:18px}.world-chart-compact svg{height:140px!important}}
@media(min-width:761px) and (max-height:800px){.world-main{padding:12px 20px}.world-top{height:20px}.world-top b{font-size:16px}.world-season{display:none}.world-main h1{font-size:28px;margin:3px 0}#worldStudentName{font-size:15px;margin:0 0 6px}.world-tabs{margin:5px 0}.world-tabs button{padding:6px 0;font-size:13px}.world-overview .world-card{padding:9px;margin:6px 0}.world-feature h3{font-size:17px}.world-feature p{font-size:11px;margin:3px 0}.world-feature button{padding:4px 8px;font-size:11px}.world-sketch{max-height:75px}.world-chart-compact svg{height:85px!important}.world-history{margin-top:5px}.world-links{margin-top:5px}#worldSubjects button{font-size:11px;padding:3px 7px}}

.world-top{height:auto;min-height:36px;gap:12px}.world-brand{display:flex;align-items:center;gap:10px}.world-brand img{display:block;flex:none;border-radius:7px}.world-main h1{font-size:24px;margin:12px 0 8px}#worldStudentName{font:700 clamp(28px,2.7vw,38px)/1.15 Georgia,serif;margin:0 0 6px;color:#233646;overflow-wrap:anywhere}.world-student-meta{font:15px/1.4 Georgia,serif;color:#78573c;margin:0 0 12px}
@media(min-width:761px) and (max-height:800px){.world-top{min-height:32px}.world-brand img{width:30px;height:30px}.world-main h1{font-size:20px;margin:7px 0 5px}#worldStudentName{font-size:28px;margin:0 0 4px}.world-student-meta{font-size:13px;margin:0 0 8px}}
@media(max-width:760px){.world-main h1{font-size:22px}#worldStudentName{font-size:30px}.world-student-meta{font-size:14px}}

.world-portrait:is([data-world-art=math],[data-world-art=biology],[data-world-art=chemistry],[data-world-art=russian],[data-world-art=english],[data-world-art=french]){background-size:contain;background-repeat:no-repeat;background-position:center center;background-color:#f3e3c9}.world-portrait:is([data-world-art=math],[data-world-art=biology],[data-world-art=chemistry],[data-world-art=russian],[data-world-art=english],[data-world-art=french]) .world-person{display:none}@media(max-width:760px){.world-portrait:is([data-world-art=math],[data-world-art=biology],[data-world-art=chemistry],[data-world-art=russian],[data-world-art=english],[data-world-art=french]){aspect-ratio:2/3;min-height:0;height:auto;background-size:contain;background-position:center top}}

/* Keep student-card navigation in view; scroll only its data. */
body:has(#learningWorld[open]){overflow:hidden}
#learningWorld{height:94dvh;max-height:94dvh;overflow:hidden}
#learningWorld .world-layout{height:100%;min-height:0;grid-template-rows:minmax(0,1fr)}
#learningWorld .world-portrait{height:100%;min-height:0;position:relative;top:auto}
#learningWorld .world-main{height:100%;min-height:0;min-width:0;position:relative;display:grid;grid-template-rows:auto minmax(0,1fr) auto;padding:14px 20px;overflow:hidden}
.world-header{min-width:0;padding-right:24px}
#learningWorld .world-top{height:0;min-height:0;display:block}
#learningWorld .world-top button{position:absolute;right:8px;top:6px;min-width:36px;min-height:36px;z-index:3}
#learningWorld .world-season{display:none}
#learningWorld .world-main h1{font-size:18px;margin:0 0 4px}
#learningWorld #worldStudentName{font-size:clamp(22px,2.4vw,30px);line-height:1.15;margin:0 0 4px}
#learningWorld .world-student-meta{font-size:12px;margin:0 0 6px}
#learningWorld #worldSubjects{max-height:72px;overflow-y:auto;padding:2px;gap:5px}
#learningWorld .world-tabs{margin:6px 0;gap:10px}
#learningWorld .world-tabs button{font-size:13px;padding:7px 0;min-height:34px}
#worldContent{min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;padding:0 3px 4px;scrollbar-gutter:stable}
#learningWorld .world-links{margin:0;padding-top:8px;gap:8px;background:#faf3e7}
#learningWorld .world-links button{min-height:34px}
#worldContent:has(.world-editor){overflow:hidden;padding-top:4px}
#worldContent>.world-card:has(.world-editor){height:100%;margin:0;display:flex;flex-direction:column;min-height:0;padding:10px}
#worldContent .world-editor{display:flex;flex-direction:column;flex:1;min-height:0;gap:8px}
.world-editor-fields{display:grid;gap:10px;min-height:0;overflow:auto;padding:3px 5px;overscroll-behavior:contain}
.world-editor-actions{display:flex;flex-wrap:wrap;gap:8px;flex:none;padding:6px 0;background:#fffcf6}
.world-editor-actions button{margin:0;min-height:36px}
@media(max-width:760px){
 #learningWorld{width:calc(100vw - 12px);height:96dvh;max-height:96dvh}
 #learningWorld .world-layout{grid-template-columns:1fr;grid-template-rows:clamp(74px,16dvh,126px) minmax(0,1fr)}
 #learningWorld .world-portrait{height:100%;min-height:0;aspect-ratio:auto!important;background-size:contain!important;background-position:center!important}
 #learningWorld .world-main{padding:10px 12px}
 #learningWorld .world-main h1{font-size:16px}
 #learningWorld #worldStudentName{font-size:22px}
 #learningWorld .world-tabs{gap:8px;flex-wrap:nowrap}
 #learningWorld .world-tabs button{font-size:12px;min-width:0;line-height:1.2;min-height:40px}
 #learningWorld #worldSubjects{max-height:66px}
 #learningWorld #worldSubjects button{font-size:11px;min-height:30px}
 #learningWorld .world-links{display:grid;grid-template-columns:1fr 1fr;padding-bottom:env(safe-area-inset-bottom,0px)}
 #learningWorld .world-links button{font-size:12px;min-height:40px}
}
@media print{#learningWorld{height:auto;max-height:none;overflow:visible}#learningWorld .world-main{display:block;height:auto;overflow:visible}#worldContent{overflow:visible}}

@media(max-width:760px){
 #learningWorld #worldSubjects{max-height:108px}
 #learningWorld .world-grade-fields{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:8px}
 #learningWorld .world-grade-fields select{min-width:0;padding:7px 4px;font-size:12px}
 #learningWorld .world-overview .world-card{padding:9px;margin:6px 0}
 #learningWorld .world-overview .world-card h3{font-size:17px}
 #learningWorld .world-overview .world-note{font-size:10px;margin:5px 0}
 #learningWorld .world-feature{grid-template-columns:minmax(0,1fr) 68px;gap:7px}
 #learningWorld .world-sketch{max-height:64px}
 #learningWorld .world-feature button{min-height:32px;padding:4px 7px}
}
@media(max-width:360px){#learningWorld .world-header{padding-right:20px}#learningWorld .world-tabs{gap:6px}#learningWorld .world-tabs button{font-size:11px}}
`;document.head.append(worldStyle);
function worldTheme(subject){const n=subject.toLowerCase();if(/хими/.test(n))return ['chemistry','',''];if(/биолог|ботаник|зоолог|анатом/.test(n))return ['biology','',''];if(/матем|алгеб|геометр/.test(n))return ['math','',''];if(/англ/.test(n))return ['english','',''];if(/русск/.test(n))return ['russian','',''];if(/франц/.test(n))return ['french','',''];return [null,subject,'Учиться, исследовать, открывать'];}
function lessonSubjectId(p){const subs=studentSubjects(student(p.studentId));return p.subjectId||subs.find(s=>s.subject===p.subject)?.id||subs[0]?.id;}
function lessonScore(l,p){const n=student(p.studentId)?.learning?.find(n=>n.lessonId===l.id&&n.subjectId===lessonSubjectId(p));return Number.isInteger(n?.score)&&n.score>=1&&n.score<=5?n.score:null;}
function openStudentLesson(id,studentId){const l=state.lessons.find(l=>l.id===id),p=l?.participants.find(p=>p.studentId===studentId);if(!p)return;openLearningWorld(studentId);worldSubjectId=lessonSubjectId(p);worldGradeLessonId=id;renderLearningWorld();}
function openLessonGrade(id,studentId){openStudentLesson(id,studentId);editWorldLesson(id);$('worldScore')?.focus();}
let worldGradeLessonId=null;
function worldGradeField(rows,today){const selected=rows.find(r=>r.lesson.id===worldGradeLessonId)||rows.filter(r=>r.lesson.date<=today).at(-1)||rows[0];if(!selected)return '<article class="world-card"><h3>Оценка за урок</h3><p>Добавьте занятие в расписание, чтобы выставить оценку.</p></article>';worldGradeLessonId=selected.lesson.id;const score=lessonScore(selected.lesson,selected.participant);return `<article class="world-card"><h3>Оценка за урок</h3><div class="world-grade-fields"><label>Занятие<select id="worldGradeLesson">${[...rows].reverse().map(r=>`<option value="${esc(r.lesson.id)}"${r.lesson.id===worldGradeLessonId?' selected':''}>${esc(formatDate(r.lesson.date))} · ${esc(r.lesson.time)}</option>`).join('')}</select></label><label>Оценка<select id="worldQuickScore"><option value="">Не выставлена</option>${[1,2,3,4,5].map(v=>`<option value="${v}"${score===v?' selected':''}>${v}</option>`).join('')}</select></label></div><p class="world-note">Оценка сохраняется автоматически и отображается в расписании.</p></article>`;}
worldDialog.addEventListener('change',e=>{if(e.target.id==='worldGradeLesson'){worldGradeLessonId=e.target.value;renderLearningWorld();return;}if(e.target.id!=='worldQuickScore')return;if(blockedStorage){toast('Сохранение заблокировано: обновите страницу.');renderLearningWorld();return;}const row=worldRows().find(r=>r.lesson.id===worldGradeLessonId),st=student(worldStudentId);if(!row||!st)return;const score=e.target.value===''?null:Number(e.target.value);if(score!==null&&(!Number.isInteger(score)||score<1||score>5))return;const before=clone(st.learning||[]),existing=worldNote(worldGradeLessonId);const note={...existing,lessonId:worldGradeLessonId,subjectId:worldSubjectId,score};st.learning=(st.learning||[]).filter(n=>!(n.lessonId===note.lessonId&&n.subjectId===note.subjectId));st.learning.push(note);if(!persist())st.learning=before;render();renderLearningWorld();});
function worldRows(){return state.lessons.flatMap(l=>l.participants.filter(p=>p.studentId===worldStudentId&&lessonSubjectId(p)===worldSubjectId).map(p=>({lesson:l,participant:p}))).sort((a,b)=>(a.lesson.date+a.lesson.time).localeCompare(b.lesson.date+b.lesson.time));}
function worldAttendanceChart(rows,today){
const past=rows.filter(r=>r.lesson.date<=today&&!['rescheduled','teacher_cancelled'].includes(r.participant.lessonStatus));
const months=[...new Set(past.map(r=>r.lesson.date.slice(0,7)))].sort().slice(-6);
if(!months.length)return '<article class="world-card"><h3>Посещения по месяцам</h3><p>Пока нет прошедших занятий.</p></article>';
const values=months.map(month=>{const rs=past.filter(r=>r.lesson.date.startsWith(month));return {month,present:rs.filter(r=>r.participant.attendance==='present').length,absent:rs.filter(r=>r.participant.attendance==='absent').length,pending:rs.filter(r=>!['present','absent'].includes(r.participant.attendance)).length};});
const max=Math.max(1,...values.map(v=>v.present+v.absent+v.pending)),step=480/values.length;
return `<article class="world-card"><h3>Посещения по месяцам</h3><p class="world-note">Последние ${values.length} мес. · количество занятий</p><svg viewBox="0 0 560 225" role="img" aria-label="График посещений: зелёный — посещения, красный — пропуски, серый — без отметки" style="width:100%;height:auto">${[0,max].map(n=>`<text x="5" y="${184-n/max*145}" font-size="12" fill="#81715f">${n}</text><line x1="32" x2="550" y1="${180-n/max*145}" y2="${180-n/max*145}" stroke="#e2d7c7"/>`).join('')}${values.map((v,i)=>{let y=180;return [['present','#40765a'],['absent','#b14b46'],['pending','#a49a8b']].map(([key,color])=>{const h=v[key]/max*145;y-=h;return `<rect x="${45+i*step}" y="${y}" width="${Math.min(48,step-15)}" height="${h}" fill="${color}"><title>${v.month}: ${v.present} посещений, ${v.absent} пропусков, ${v.pending} без отметки</title></rect>`;}).join('')+`<text x="${45+i*step}" y="205" font-size="12" fill="#66543f">${v.month.slice(5)}.${v.month.slice(2,4)}</text>`;}).join('')}</svg><p style="font-size:12px"><span style="color:#40765a">● Посещения</span> · <span style="color:#b14b46">● Пропуски</span> · <span style="color:#817568">● Без отметки</span></p><ul class="world-score-list">${values.map(v=>`<li><span>${v.month}</span><span>${v.present} посещений · ${v.absent} пропусков · ${v.pending} без отметки</span></li>`).join('')}</ul><p class="world-note">Будущие занятия, переносы и отмены преподавателем не включены. Неотмеченное занятие не считается пропуском.</p></article>`;
}

function worldSketch(subject,homework=false){
const math=/матем|алгеб|геометр/i.test(subject),french=/франц/i.test(subject);
return `<svg viewBox="0 0 160 105" aria-hidden="true" class="world-sketch"><defs><pattern id="worldGrid${homework?'H':'L'}" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M 12 0 H 0 V 12" fill="none" stroke="#bdac91" stroke-width=".4"/></pattern></defs><rect width="160" height="105" rx="8" fill="#f0e5d2"/><rect width="160" height="105" fill="url(#worldGrid${homework?'H':'L'})"/>${math?homework?'<path d="M25 15L115 20L125 92L35 88Z" fill="#fffaf0" stroke="#867052"/><text x="40" y="43" font-family="Georgia" font-style="italic" font-size="14" fill="#715436">2x + 3 = 7</text><text x="48" y="65" font-family="Georgia" font-style="italic" font-size="14" fill="#715436">x = 2</text><path d="M128 18L112 79" stroke="#5f6d73" stroke-width="4"/>':'<path d="M24 80H140M40 94V12M30 85L128 25" fill="none" stroke="#796142" stroke-width="1.3"/><circle cx="40" cy="80" r="3" fill="#996637"/><path d="M128 25V80H40" stroke="#996637" stroke-dasharray="3 3" fill="none"/><text x="65" y="98" font-family="Georgia" font-size="12" fill="#796142">y = kx + b</text>':`<path d="M28 22Q53 15 80 27Q107 15 132 22V85Q106 78 80 89Q54 78 28 85Z M80 27V89" fill="#fffaf0" stroke="#8a7050"/><path d="M37 36L68 39M37 46L68 49M37 56L68 59M91 39L123 36M91 49L123 46M91 59L123 56" stroke="#ad9678"/><text x="44" y="75" font-family="Georgia" font-style="italic" font-size="13" fill="#795738">${french?'é · è · ê':'Aa · Bb'}</text>`}<path d="M10 8V98M7 16H13M7 89H13M20 9H146" stroke="#af9776" stroke-width=".7" stroke-dasharray="3 3"/></svg>`;
}
function worldOverview(rows,today,subject){
const next=rows.find(r=>r.lesson.date>=today&&r.participant.attendance==='pending'&&!['rescheduled','teacher_cancelled'].includes(r.participant.lessonStatus));
const assignments=rows.filter(r=>worldNote(r.lesson.id)?.homework),unfinished=assignments.filter(r=>worldNote(r.lesson.id).homeworkStatus!=='done'),hw=unfinished.at(-1)||assignments.at(-1),n=hw?worldNote(hw.lesson.id):null;
const note=next?worldNote(next.lesson.id):null;
return `<div class="world-overview">${worldGradeField(rows,today)}<article class="world-card world-feature"><div class="world-feature-body"><div class="world-meta">▦ Следующий урок</div><h3>${next?esc(formatDate(next.lesson.date))+' · '+esc(next.lesson.time):'Урок пока не запланирован'}</h3><p>${esc(note?.topic||'Тема ещё не указана')}</p>${next?`<button type="button" data-world-lesson="${esc(next.lesson.id)}">Открыть занятие →</button>`:''}</div>${worldSketch(subject)}</article><article class="world-card world-feature"><div class="world-feature-body"><div class="world-meta">▤ Домашнее задание</div><h3>${esc(n?.homework||'Задание ещё не внесено')}</h3><p>${n?.dueDate?'Срок: '+esc(formatDate(n.dueDate)):n?'Срок не указан':'Преподаватель добавит задание к уроку'}</p>${hw?`<button type="button" class="primary" data-world-edit="${esc(hw.lesson.id)}">Открыть задание →</button>`:next?`<button type="button" data-world-edit="${esc(next.lesson.id)}">Добавить задание →</button>`:''}</div>${worldSketch(subject,true)}</article><div class="world-chart-compact">${worldAttendanceChart(rows,today)}</div></div><details class="world-history"><summary>История занятий</summary>${rows.filter(r=>r.lesson.date<=today).slice(-20).reverse().map(r=>`<p>${esc(formatDate(r.lesson.date))} · ${esc(r.lesson.time)} <button type="button" data-world-edit="${esc(r.lesson.id)}">Тема, ДЗ и оценка</button></p>`).join('')||'<p>Прошедших занятий пока нет.</p>'}</details>`;
}

function worldNote(id){return student(worldStudentId)?.learning?.find(n=>n.lessonId===id&&n.subjectId===worldSubjectId);}
function openLearningWorld(id){const st=student(id);if(!st)return;worldStudentId=id;worldGradeLessonId=null;worldSubjectId=studentSubjects(st)[0]?.id;worldSection='lessons';renderLearningWorld();worldDialog.showModal();}
function renderLearningWorld(){const st=student(worldStudentId);if(!st)return;const subs=studentSubjects(st),sub=subs.find(s=>s.id===worldSubjectId)||subs[0];worldSubjectId=sub?.id;const [key,title,subtitle]=worldTheme(sub?.subject||'Мои занятия');worldDialog.style.setProperty('--portrait',key?'url("'+worldArt[key]+'")':'none');worldDialog.querySelector('.world-portrait').dataset.worldArt=key||'';worldDialog.querySelector('.world-person h2').textContent=title;worldDialog.querySelector('.world-person p').textContent=subtitle;$('worldStudentName').textContent=st.name;$('worldStudentMeta').textContent=[st.grade,sub?.subject].filter(Boolean).join(' · ');$('worldSubjects').innerHTML=subs.map(s=>`<button type="button" data-world-subject="${esc(s.id)}" aria-pressed="${s.id===worldSubjectId}">${esc(s.subject)}</button>`).join('');for(const b of worldDialog.querySelectorAll('[data-world-tab]'))b.setAttribute('aria-selected',String(b.dataset.worldTab===worldSection));const rows=worldRows(),today=isoDate(new Date());let html='';
const card=({lesson:l,participant:p},next=false)=>{const n=worldNote(l.id);return `<article class="world-card"><div class="world-meta">${next?'Следующий урок · ':''}${esc(formatDate(l.date))} · ${esc(l.time)} · ${l.durationMinutes||60} мин</div><h3>${esc(n?.topic||'Тема ещё не указана')}</h3><p>${p.attendance==='present'?'Присутствовал':p.attendance==='absent'?'Пропуск':'Посещение ещё не отмечено'}${n?.score?' · Оценка '+esc(n.score)+'/5':''}</p>${n?.homework?`<p>ДЗ: ${esc(n.homework)}</p>`:''}<button type="button" class="primary" data-world-edit="${esc(l.id)}">${n?.homework?'Открыть задание':'Тема, ДЗ и оценка'}</button><button type="button" data-world-lesson="${esc(l.id)}">Занятие в расписании</button></article>`;};
if(worldSection==='lessons')html=worldOverview(rows,today,sub?.subject||'');
if(worldSection==='homework'){const assigned=rows.filter(r=>worldNote(r.lesson.id)?.homework);html=assigned.reverse().map(r=>{const n=worldNote(r.lesson.id);return `<article class="world-card"><div class="world-meta">Урок ${esc(formatDate(r.lesson.date))}${n.dueDate?' · Срок '+esc(formatDate(n.dueDate)):''}</div><h3>${esc(n.topic||'Домашнее задание')}</h3><p>${esc(n.homework)}</p><p class="world-status">${({assigned:'Задано',done:'Выполнено',review:'Нужна доработка'})[n.homeworkStatus]||'Задано'}</p><button type="button" data-world-edit="${esc(r.lesson.id)}">Открыть задание</button></article>`;}).join('')||'<article class="world-card"><h3>Задания ещё не внесены</h3><p>Откройте урок во вкладке «Занятия», чтобы записать ДЗ.</p></article>';}
if(worldSection==='progress'){const notes=rows.map(r=>({r,n:worldNote(r.lesson.id)})),graded=notes.filter(x=>x.n?.score),assigned=notes.filter(x=>x.n?.homework),done=assigned.filter(x=>x.n.homeworkStatus==='done'),attended=rows.filter(x=>x.participant.attendance==='present').length;html=`<div class="world-kpis"><div class="world-kpi"><b>${attended}</b><span>Посещено занятий</span></div><div class="world-kpi"><b>${graded.length?(graded.reduce((s,x)=>s+x.n.score,0)/graded.length).toFixed(1):'—'}</b><span>Средняя оценка из 5</span></div><div class="world-kpi"><b>${done.length} / ${assigned.length}</b><span>ДЗ выполнено</span></div><div class="world-kpi"><b>${assigned.length?Math.round(done.length/assigned.length*100)+'%':'—'}</b><span>Доля выполненных ДЗ</span></div></div>${worldAttendanceChart(rows,today)}<h3>Оценки по датам</h3><ul class="world-score-list">${graded.map(x=>`<li><span>${esc(formatDate(x.r.lesson.date))} · ${esc(x.n.topic||'Занятие')}</span><b>${esc(x.n.score)}/5</b></li>`).join('')}</ul><p class="world-note">Показатели рассчитаны только по внесённым данным выбранного предмета. Оценки и выполнение ДЗ отмечает преподаватель.</p>`;}
$('worldContent').innerHTML=html;}
function editWorldLesson(id){worldGradeLessonId=id;const row=worldRows().find(r=>r.lesson.id===id);if(!row)return;const n=worldNote(id)||{};$('worldContent').innerHTML=`<article class="world-card"><h3>Урок ${esc(formatDate(row.lesson.date))} · ${esc(row.lesson.time)}</h3><div class="world-editor"><div class="world-editor-fields"><label>Тема занятия<input id="worldTopic" maxlength="300" value="${esc(n.topic||'')}"></label><label>Домашнее задание<textarea id="worldHomework" maxlength="3000">${esc(n.homework||'')}</textarea></label><label>Срок сдачи<input id="worldDue" type="date" value="${esc(n.dueDate||'')}"></label><label>Результат ДЗ<select id="worldHomeworkStatus">${[['assigned','Задано'],['done','Выполнено'],['review','Нужна доработка']].map(([v,t])=>`<option value="${v}"${n.homeworkStatus===v?' selected':''}>${t}</option>`).join('')}</select></label><label>Оценка за урок<select id="worldScore"><option value="">Не выставлена</option>${[1,2,3,4,5].map(v=>`<option value="${v}"${n.score===v?' selected':''}>${v}</option>`).join('')}</select></label><p id="worldError" role="alert"></p></div><div class="world-editor-actions"><button type="button" class="primary" data-world-save="${esc(id)}">Сохранить</button><button type="button" data-world-back>Назад</button></div></div></article>`;}
worldDialog.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-world-close'))worldDialog.close();else if(b.dataset.worldSubject){worldSubjectId=b.dataset.worldSubject;renderLearningWorld();}else if(b.dataset.worldTab){worldSection=b.dataset.worldTab;renderLearningWorld();}else if(b.dataset.worldEdit)editWorldLesson(b.dataset.worldEdit);else if(b.hasAttribute('data-world-back'))renderLearningWorld();else if(b.dataset.worldLesson){const id=b.dataset.worldLesson;worldDialog.close();openLesson(id);}else if(b.dataset.worldSave){if(blockedStorage){$('worldError').textContent='Сохранение заблокировано: обновите сессию после резервной копии.';return;}const st=student(worldStudentId),before=clone(st.learning||[]);const note={lessonId:b.dataset.worldSave,subjectId:worldSubjectId,topic:$('worldTopic').value.trim(),homework:$('worldHomework').value.trim(),dueDate:$('worldDue').value,homeworkStatus:$('worldHomeworkStatus').value,score:$('worldScore').value?Number($('worldScore').value):null};st.learning=(st.learning||[]).filter(n=>!(n.lessonId===note.lessonId&&n.subjectId===note.subjectId));st.learning.push(note);if(!persist()){st.learning=before;return; }render();renderLearningWorld();toast('Отправлено на сохранение. Статус подтверждения — в шапке дневника.');}});
const originalStudentOpen=openStudent;openStudent=function(id,tab='profile'){if(id&&tab==='profile')openLearningWorld(id);else originalStudentOpen(id,tab);};
$('worldProfile').onclick=()=>{worldDialog.close();originalStudentOpen(worldStudentId,'profile');};$('worldFinance').onclick=()=>{worldDialog.close();originalStudentOpen(worldStudentId,'payments');};

// Keep the underlying lesson form in sync after grading in the student card.
worldDialog.addEventListener('close',()=>{if(!$('lessonDialog').open||!draft)return;for(const card of $('participants').querySelectorAll('.participant')){const p=draft.participants[Number(card.dataset.index)],input=card.querySelector('[data-field="score"]');if(p&&input&&!lessonScoreDrafts.has(scoreDraftKey(p))){input.value=String(lessonScore(draft,p)??'');input.dataset.originalScore=input.value;}}});

render();
offline.mount({getState:()=>state,saved:()=>{blockedStorage=false;$('storageAlert').hidden=true;},replace:newState=>{state=validateState(upgradeState(newState));blockedStorage=false;$('storageAlert').hidden=true;render();}});

$('helpBtn').onclick=()=>toast('Нажмите на занятие: измените посещение, оплату или оценку. Откройте «Ученики и отчёты», чтобы посмотреть карточки.');
$('startTraining').onclick=()=>close('onboardingWelcome');
$('skipTraining').onclick=()=>close('onboardingWelcome');
$('exportData').onclick=$('importData').onclick=()=>toast('Чтобы сохранять свои данные, нажмите «Создать свой дневник» вверху страницы.');
const demoGoals=new Set();
function demoGoal(name){if(demoGoals.has(name))return;demoGoals.add(name);if(typeof window.ym==='function')window.ym(114078796,'reachGoal',name);}
document.addEventListener('click',e=>{
 const target=e.target.closest('button,a,[data-edit]');
 if(!target)return;
 if(target.matches('[data-register]')){demoGoal('registration_click');return;}
 if(!target.closest('#demoNotice'))demoGoal('demo_interaction');
});


})();