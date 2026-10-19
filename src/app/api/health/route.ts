export function GET() { return Response.json({ok:true,service:'orvo',testMode:process.env.ORVO_TEST_MODE==='1'}); }
