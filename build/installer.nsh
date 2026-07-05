; ============================================================
; YANKENT POS — Custom NSIS Installer Script
; Dark, monochrome brand aesthetic matching the app's login screen.
; ============================================================

; ---- UI branding (bitmaps) ----------------------------------
; Sidebar shown on Welcome + Finish pages (164x314 px BMP) and the
; header shown on inner pages (150x57 px BMP) are configured via
; package.json build.nsis.installerSidebar / installerHeader so they
; are set before this script is included (NSIS pre-defines the MUI
; bitmap variables and would throw "already defined" if we touched them).

; ---- Icon ---------------------------------------------------
; The installer icon is set via package.json build.win.icon.
; NSIS uses it automatically for the .exe and uninstaller.

; ---- Colors (dark theme) ------------------------------------
; NSIS MUI_INSTFILESPAGE_COLORS takes exactly 2 hex values: foreground
; (text) and background.  We use white-on-dark for the file-copy
; progress page so it matches the brand.
!define MUI_INSTFILESPAGE_COLORS "0xFFFFFF 0x0A0A0E"
; Welcome/Finish page text color (light text on dark sidebar)
!define MUI_WELCOMEPAGE_TITLE_COLOR "0xF4F4F5"
!define MUI_FINISHPAGE_TITLE_COLOR "0xF4F4F5"

; ---- Welcome page text --------------------------------------
!define MUI_WELCOMEPAGE_TITLE "YANKENT POS"
!define MUI_WELCOMEPAGE_TEXT "Construction & Supply Point of Sale$\r$\n$\r$\nThis installer will set up YANKENT POS on your computer.  It includes the POS application and the thermal printer driver.$\r$\n$\r$\nIt is recommended to close all other applications before continuing.$\r$\n$\r$\nClick Next to continue."

; ---- Finish page text ---------------------------------------
!define MUI_FINISHPAGE_TITLE "Setup Complete"
!define MUI_FINISHPAGE_TEXT "YANKENT POS has been installed successfully.$\r$\n$\r$\nThe thermal printer driver has been copied to your Downloads folder.$\r$\n$\r$\nYou can launch YANKENT POS from the desktop shortcut.$\r$\n$\r$\nClick Finish to exit."
!define MUI_FINISHPAGE_RUN_TEXT "Launch YANKENT POS now"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "View the Quick Start Guide"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\QUICKSTART.txt"

; ---- Uninstaller text ---------------------------------------
!define MUI_UNCONFIRMPAGE_TEXT_TOP "YANKENT POS will be completely removed from your computer.  Your sales data and settings will remain in the app data folder and can be manually backed up.$\r$\n$\r$\nClick Uninstall to continue."

; ============================================================
; Custom install steps
; ============================================================
!macro customInstall
  ; Show a branded detail line during install
  DetailPrint "========================================"
  DetailPrint "  YANKENT POS - Construction & Supply"
  DetailPrint "  Installing POS application..."
  DetailPrint "========================================"

  ${ifNot} ${isUpdated}
    DetailPrint "Running YANKENT POS thermal printer driver setup..."
    File /oname=$PLUGINSDIR\PrinterDriver.exe "${PROJECT_DIR}\resources\PrinterDriver.exe"
    ExecWait '"$PLUGINSDIR\PrinterDriver.exe"'
    DetailPrint "Printer driver setup complete."
  ${endIf}

  ; Write a quick-start guide
  FileOpen $0 "$INSTDIR\QUICKSTART.txt" w
  FileWrite $0 "YANKENT POS - Quick Start Guide$\r$\n"
  FileWrite $0 "====================================$\r$\n$\r$\n"
  FileWrite $0 "1. Launch YANKENT POS from the desktop shortcut$\r$\n"
  FileWrite $0 "2. Log in with your admin or cashier credentials$\r$\n"
  FileWrite $0 "3. Go to Settings to configure your store name, address, and TIN$\r$\n"
  FileWrite $0 "4. Go to Products to add your inventory and set prices$\r$\n"
  FileWrite $0 "5. Start selling from the Point of Sale tab$\r$\n$\r$\n"
  FileWrite $0 "Default admin login: admin / admin123$\r$\n"
  FileWrite $0 "Change this password immediately in Settings - Users.$\r$\n$\r$\n"
  FileWrite $0 "Printer setup:$\r$\n"
  FileWrite $0 "  - The printer driver is in your Downloads folder$\r$\n"
  FileWrite $0 "  - On the login screen, click 'Setup Printer' to pair$\r$\n"
  FileWrite $0 "  - Set printer type to 'System printer' in Settings$\r$\n$\r$\n"
  FileWrite $0 "Support: Contact your system administrator.$\r$\n"
  FileClose $0
  DetailPrint "Quick Start Guide written."
!macroend

; ============================================================
; Custom uninstall steps
; ============================================================
!macro customUnInstall
  ; Clean up the auto-start registry value if a previous install set it.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "YANKENT POS"
  DetailPrint "Removed YANKENT POS startup entry (if present)."
  Delete "$INSTDIR\QUICKSTART.txt"
!macroend