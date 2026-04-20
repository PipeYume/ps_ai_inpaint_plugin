
function InitDebug() {
    const btnToggleSettings = document.getElementById('btnToggleSettings');

    const btnDebugClose = document.getElementById('btnDebugClose');
    let clickCount = 0;
    let clickTimer = null;

    let isDebugMode = false
    
    function openDebugMode(){
        isDebugMode = true;
        btnDebugClose.style.display = 'block';
    }
    function closeDebugMode(){
        isDebugMode = false;
        btnDebugClose.style.display = 'none';
    }

    closeDebugMode()

    btnToggleSettings.addEventListener('click', () => {
        clickCount++;
        if (clickCount >= 4) {
            if(isDebugMode){
                closeDebugMode()
            }else{
                openDebugMode()
            }
            clickCount = 0;
        }

        // 每次点击后，500毫秒内没有连击，则计数归零
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
            clickCount = 0;
        }, 500);
    });
}

InitDebug();