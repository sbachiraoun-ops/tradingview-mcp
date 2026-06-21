//+------------------------------------------------------------------+
//|                                          AMD_CISD_IFVG_MT5.mq5    |
//|   ICT "Power of 3" model — works on ANY symbol (forex, indices,  |
//|   metals, crypto) on FBS MT5 or any MT5 broker.                  |
//|                                                                  |
//|   ACCUMULATION -> swing liquidity pool (pivot high/low)          |
//|   MANIPULATION -> sweep of that pool + rejection back inside     |
//|   CISD         -> close reclaims the sweep candle's extreme      |
//|   IFVG         -> opposing FVG inverts polarity (close through)  |
//|   DISTRIBUTION -> the run we ride toward opposite liquidity      |
//|                                                                  |
//|   Risk handled for you: stop beyond the manipulation extreme,    |
//|   fixed R:R target, % -account-risk sizing computed from the     |
//|   symbol's real tick value so it is correct on every instrument. |
//+------------------------------------------------------------------+
#property copyright "Mission 4"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>
CTrade trade;

//--- Inputs -------------------------------------------------------------------
input group "Risk / Targets"
input double InpRiskPct      = 1.0;    // Risk % of balance per trade
input double InpRR           = 2.0;    // Reward : Risk
input double InpSLBufferATR  = 0.5;    // Stop buffer beyond sweep (x ATR)
input int    InpATRPeriod    = 14;     // ATR period (scales to any symbol)

input group "Structure"
input int    InpPivotLen     = 5;      // Liquidity pivot length (bars each side)
input int    InpArmBars      = 12;     // Bars to confirm after a sweep
input int    InpMaxTradesDay = 2;      // Max trades per day

input group "Confirmation"
input bool   InpRequireIFVG  = true;   // Require IFVG (inversion) confirmation
input bool   InpRequireFVG   = false;  // Require a fresh FVG in the displacement

input group "Session (optional, broker time)"
input bool   InpUseHours     = false;  // Restrict to an hour window
input int    InpStartHour    = 7;      // Start hour (broker time)
input int    InpEndHour      = 16;     // End hour (broker time)

input group "General"
input long   InpMagic        = 20260615; // Magic number
input int    InpSlippage     = 20;       // Deviation (points)

//--- Globals ------------------------------------------------------------------
int      atrHandle = INVALID_HANDLE;
datetime lastBarTime = 0;
long     barCount = 0;

double   buyLiq  = 0.0;   // last swing high  (sweep => short setup)
double   sellLiq = 0.0;   // last swing low   (sweep => long setup)

bool     armL = false;  double cisdL = 0, manipL = 0, ifvgTopL = 0;  long barL = 0;
bool     armS = false;  double cisdS = 0, manipH = 0, ifvgBotS = 0;  long barS = 0;

int      tradesToday = 0;
int      currentDay  = -1;

//+------------------------------------------------------------------+
int OnInit()
{
   atrHandle = iATR(_Symbol, _Period, InpATRPeriod);
   if(atrHandle == INVALID_HANDLE)
   {
      Print("Failed to create ATR handle");
      return INIT_FAILED;
   }
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(_Symbol);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(atrHandle != INVALID_HANDLE) IndicatorRelease(atrHandle);
}

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
double H(int s){ return iHigh(_Symbol, _Period, s); }
double L(int s){ return iLow (_Symbol, _Period, s); }
double C(int s){ return iClose(_Symbol, _Period, s); }

bool IsPivotHigh(int shift, int len)
{
   double v = H(shift);
   for(int k = 1; k <= len; k++)
      if(v <= H(shift + k) || v <= H(shift - k)) return false;
   return true;
}
bool IsPivotLow(int shift, int len)
{
   double v = L(shift);
   for(int k = 1; k <= len; k++)
      if(v >= L(shift + k) || v >= L(shift - k)) return false;
   return true;
}

double GetATR()
{
   double buf[];
   if(CopyBuffer(atrHandle, 0, 1, 1, buf) <= 0) return 0.0;
   return buf[0];
}

bool HasPosition()
{
   if(PositionSelect(_Symbol))
      if(PositionGetInteger(POSITION_MAGIC) == InpMagic) return true;
   return false;
}

double CalcLot(double slDistancePrice)
{
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickVal  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   if(tickSize <= 0 || tickVal <= 0 || slDistancePrice <= 0) return 0.0;

   double pointValue = tickVal / tickSize;                       // money per 1.0 price / lot
   double riskAmt    = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPct / 100.0;
   double lot        = riskAmt / (slDistancePrice * pointValue);

   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step > 0) lot = MathFloor(lot / step) * step;
   if(lot < minL) lot = minL;
   if(lot > maxL) lot = maxL;
   return lot;
}

bool InHours()
{
   if(!InpUseHours) return true;
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   if(InpStartHour <= InpEndHour) return (dt.hour >= InpStartHour && dt.hour < InpEndHour);
   return (dt.hour >= InpStartHour || dt.hour < InpEndHour); // window wraps midnight
}

//+------------------------------------------------------------------+
//| Main — process once per new (closed) bar                         |
//+------------------------------------------------------------------+
void OnTick()
{
   datetime t = iTime(_Symbol, _Period, 0);
   if(t == lastBarTime) return;       // act only on a new bar
   lastBarTime = t;
   barCount++;

   // need enough history
   if(Bars(_Symbol, _Period) < InpPivotLen * 2 + 5) return;

   // daily trade counter reset
   MqlDateTime dt; TimeToStruct(t, dt);
   if(dt.day != currentDay){ currentDay = dt.day; tradesToday = 0; }

   bool tradeOK = InHours();

   //--- last CLOSED bar is shift 1 ------------------------------------------
   double h1 = H(1), l1 = L(1), c1 = C(1);
   double low3 = L(3), high3 = H(3);

   //--- ACCUMULATION: refresh liquidity pools (just-confirmed pivot) ---------
   int ps = InpPivotLen + 1;          // newest confirmable pivot shift
   if(IsPivotHigh(ps, InpPivotLen)) buyLiq  = H(ps);
   if(IsPivotLow (ps, InpPivotLen)) sellLiq = L(ps);

   //--- MANIPULATION: sweep with rejection back inside ----------------------
   bool bullSweep = (sellLiq > 0 && l1 < sellLiq && c1 > sellLiq);
   bool bearSweep = (buyLiq  > 0 && h1 > buyLiq  && c1 < buyLiq);

   //--- 3-bar FVGs -----------------------------------------------------------
   bool bullFVG = (l1 > high3);
   bool bearFVG = (h1 < low3);

   //--- arm LONG -------------------------------------------------------------
   if(bullSweep && tradeOK){ armL = true; cisdL = h1; manipL = l1; barL = barCount; ifvgTopL = 0; }
   if(armL)
   {
      manipL = MathMin(manipL, l1);
      if(bearFVG) ifvgTopL = low3;                 // upper edge of bearish FVG
      if(barCount - barL > InpArmBars || c1 < manipL) armL = false;
   }

   //--- arm SHORT ------------------------------------------------------------
   if(bearSweep && tradeOK){ armS = true; cisdS = l1; manipH = h1; barS = barCount; ifvgBotS = 0; }
   if(armS)
   {
      manipH = MathMax(manipH, h1);
      if(bullFVG) ifvgBotS = high3;                // lower edge of bullish FVG
      if(barCount - barS > InpArmBars || c1 > manipH) armS = false;
   }

   //--- CISD + IFVG confirmation = ENTRY ------------------------------------
   bool ifvgLongOK  = (!InpRequireIFVG) || (ifvgTopL > 0 && c1 > ifvgTopL);
   bool ifvgShortOK = (!InpRequireIFVG) || (ifvgBotS > 0 && c1 < ifvgBotS);
   bool fvgLongOK   = (!InpRequireFVG)  || bullFVG;
   bool fvgShortOK  = (!InpRequireFVG)  || bearFVG;

   bool longSig  = armL && c1 > cisdL && ifvgLongOK  && fvgLongOK;
   bool shortSig = armS && c1 < cisdS && ifvgShortOK && fvgShortOK;

   bool canTrade = (!HasPosition()) && tradesToday < InpMaxTradesDay && tradeOK;
   if(!canTrade) return;

   double atr = GetATR();
   if(atr <= 0) return;
   double buf      = InpSLBufferATR * atr;
   long   stopsLvl = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minStop  = stopsLvl * _Point;

   if(longSig)
   {
      double entry = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double sl    = manipL - buf;
      if(entry - sl < minStop) sl = entry - minStop;
      double dist  = entry - sl;
      double tp    = entry + InpRR * dist;
      double lot   = CalcLot(dist);
      if(lot > 0 && dist > 0)
      {
         sl = NormalizeDouble(sl, _Digits);
         tp = NormalizeDouble(tp, _Digits);
         if(trade.Buy(lot, _Symbol, 0.0, sl, tp, "AMD/CISD/IFVG long"))
         {
            tradesToday++;
            armL = false;
         }
      }
   }
   else if(shortSig)
   {
      double entry = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double sl    = manipH + buf;
      if(sl - entry < minStop) sl = entry + minStop;
      double dist  = sl - entry;
      double tp    = entry - InpRR * dist;
      double lot   = CalcLot(dist);
      if(lot > 0 && dist > 0)
      {
         sl = NormalizeDouble(sl, _Digits);
         tp = NormalizeDouble(tp, _Digits);
         if(trade.Sell(lot, _Symbol, 0.0, sl, tp, "AMD/CISD/IFVG short"))
         {
            tradesToday++;
            armS = false;
         }
      }
   }
}
//+------------------------------------------------------------------+
