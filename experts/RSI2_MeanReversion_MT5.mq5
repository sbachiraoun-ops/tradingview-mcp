//+------------------------------------------------------------------+
//|                                    RSI2_MeanReversion_MT5.mq5     |
//|   Larry Connors RSI-2 mean reversion, PF-tuned. Works on ANY      |
//|   symbol on FBS MT5 (indices best: US100/US500/US30; also forex). |
//|                                                                  |
//|   ENTRY : close > 200-SMA  AND  RSI(2) < threshold (def 5)       |
//|   EXIT  : close > fast SMA  OR  RSI(2) > 65  OR  time-stop       |
//|   STOP  : 2.5 x ATR(10) below entry (wide on purpose)           |
//|   SIZE  : % -balance risk via real tick value (any instrument)  |
//|                                                                  |
//|   Push PF up: lower RSI threshold (5->3), require N lower closes,|
//|   widen ATR stop (2.5->3.0).                                     |
//+------------------------------------------------------------------+
#property version "1.00"
#property strict
#include <Trade/Trade.mqh>
CTrade trade;

//--- Inputs -------------------------------------------------------------------
input group "Entry"
input int    InpRSIPeriod   = 2;       // RSI period
input double InpBuyTh       = 5.0;     // Buy when RSI < this
input int    InpTrendSMA    = 200;     // Only buy above this SMA
input int    InpNeedDown    = 0;       // Min consecutive lower closes (0=off)

input group "Exit"
input bool   InpUseSMAExit  = true;    // Exit when close > fast SMA
input int    InpFastSMA     = 5;       // Fast SMA
input bool   InpUseRSIExit  = true;    // Exit when RSI > level
input double InpExitRSI     = 65.0;    // RSI exit level
input bool   InpUseTimeStop = true;    // Use time stop
input int    InpMaxBars     = 10;      // Max bars in trade

input group "Risk"
input double InpRiskPct     = 1.0;     // Risk % of balance per trade
input int    InpATRPeriod   = 10;      // ATR period
input double InpATRMult     = 2.5;     // Stop = ATR x

input group "General"
input long   InpMagic       = 20260616;
input int    InpSlippage    = 20;

//--- Handles / state ----------------------------------------------------------
int      hRSI = INVALID_HANDLE, hATR = INVALID_HANDLE, hTrend = INVALID_HANDLE, hFast = INVALID_HANDLE;
datetime lastBarTime = 0;
long     barCount = 0, entryBar = 0;

int OnInit()
{
   hRSI   = iRSI(_Symbol, _Period, InpRSIPeriod, PRICE_CLOSE);
   hATR   = iATR(_Symbol, _Period, InpATRPeriod);
   hTrend = iMA (_Symbol, _Period, InpTrendSMA, 0, MODE_SMA, PRICE_CLOSE);
   hFast  = iMA (_Symbol, _Period, InpFastSMA,  0, MODE_SMA, PRICE_CLOSE);
   if(hRSI==INVALID_HANDLE||hATR==INVALID_HANDLE||hTrend==INVALID_HANDLE||hFast==INVALID_HANDLE)
      return INIT_FAILED;
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(_Symbol);
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason)
{
   IndicatorRelease(hRSI); IndicatorRelease(hATR);
   IndicatorRelease(hTrend); IndicatorRelease(hFast);
}

//--- helpers ------------------------------------------------------------------
double Buf(int handle, int shift)
{
   double b[];
   if(CopyBuffer(handle, 0, shift, 1, b) <= 0) return EMPTY_VALUE;
   return b[0];
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
   if(tickSize<=0 || tickVal<=0 || slDistancePrice<=0) return 0.0;
   double pointValue = tickVal / tickSize;
   double riskAmt    = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPct / 100.0;
   double lot        = riskAmt / (slDistancePrice * pointValue);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step>0) lot = MathFloor(lot/step)*step;
   if(lot<minL) lot = minL;
   if(lot>maxL) lot = maxL;
   return lot;
}
int ConsecutiveLowerCloses()
{
   int n = 0;
   for(int s = 1; s <= 50; s++)
   {
      if(iClose(_Symbol,_Period,s) < iClose(_Symbol,_Period,s+1)) n++;
      else break;
   }
   return n;
}

//+------------------------------------------------------------------+
void OnTick()
{
   datetime t = iTime(_Symbol, _Period, 0);
   if(t == lastBarTime) return;       // new bar only
   lastBarTime = t;
   barCount++;

   if(Bars(_Symbol,_Period) < InpTrendSMA + 5) return;

   double rsi1   = Buf(hRSI,   1);
   double atr1   = Buf(hATR,   1);
   double trend1 = Buf(hTrend, 1);
   double fast1  = Buf(hFast,  1);
   double close1 = iClose(_Symbol, _Period, 1);
   if(rsi1==EMPTY_VALUE || atr1==EMPTY_VALUE || trend1==EMPTY_VALUE || fast1==EMPTY_VALUE) return;

   //--- manage open position ------------------------------------------------
   if(HasPosition())
   {
      bool exitMean = (InpUseSMAExit && close1 > fast1) || (InpUseRSIExit && rsi1 > InpExitRSI);
      bool timeOut  = InpUseTimeStop && (barCount - entryBar >= InpMaxBars);
      if(exitMean || timeOut)
         trade.PositionClose(_Symbol);
      return;
   }

   //--- entry ---------------------------------------------------------------
   bool trendOK = close1 > trend1;
   bool downOK  = (InpNeedDown <= 0) || (ConsecutiveLowerCloses() >= InpNeedDown);
   bool longSig = trendOK && rsi1 < InpBuyTh && downOK;
   if(!longSig) return;

   double entry = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double sl    = entry - InpATRMult * atr1;
   long   stops = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minSt = stops * _Point;
   if(entry - sl < minSt) sl = entry - minSt;
   double dist  = entry - sl;
   double lot   = CalcLot(dist);
   if(lot <= 0 || dist <= 0) return;

   sl = NormalizeDouble(sl, _Digits);
   if(trade.Buy(lot, _Symbol, 0.0, sl, 0.0, "RSI2 mean-reversion"))
      entryBar = barCount;
}
//+------------------------------------------------------------------+
